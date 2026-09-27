/**
 * Durable stage state: stage run allocation and stage evidence bundles (issue
 * #1099 — the persistence half of `docs/staged-verification-contract.md` §13's
 * S4, specified by §6.2 and §6.3 and by
 * `docs/verification-evidence-validity-contract.md` §4.2, §7.1 and §8).
 *
 * A stage run is durable in exactly two moments, and this module owns both:
 *
 * 1. **Allocated** — the ordinal is taken and the launch identity is written
 *    *before the first check process exists* (#1096 §4.3 rule 1, §7.1 rule 2).
 * 2. **Recorded** — the bundle lands, in one transaction, with whatever else
 *    the completion carries (#1094 §8's one-transaction rule).
 *
 * "No third state" is the whole point (#1096 §7.1 rule 3). An allocated
 * ordinal with no bundle is not an ambiguity, it is the signature of an
 * interrupted run: it is never resumed, never partially credited, and the next
 * allocation takes the *next* ordinal rather than reusing one.
 *
 * What this module deliberately is not:
 *
 * - **Not a store.** #1094 §9 and #1096 §10 invariant 20 forbid a new store,
 *   table or command family. The state is one task-context key written through
 *   the shipped `TaskStore.completePhaseWithEffects` CAS, exactly as #1038's
 *   revision chain is — so a handler or an admin command never writes SQLite
 *   directly, and a later slice's grant can ride the same transaction by
 *   passing its outbox effects to {@link recordStageRun}.
 * - **Not the stage model.** `selectStageChecks`, #1094 §6.1's outcome
 *   precedence, #1096 §4.4's matching law and the §6 pin records are slice
 *   S1's and S5's. The vocabularies are declared here because persistence has
 *   to validate them; the *decisions* over them are not. The outcome, the
 *   verdicts and the identity are facts this module records, never facts it
 *   derives.
 * - **Not routing, not selection, not publication.** Nothing here schedules a
 *   stage, chooses a check, spawns an adapter, grants stack-ready or reaches a
 *   phase handler. No shipped call site reads this key yet, so an enabled
 *   session behaves exactly as it does today.
 *
 * Two asymmetries are deliberate and are tested:
 *
 * - **Writes validate strictly; reads of legacy evidence fail *soft on the two
 *   fields a contract says read that way*.** A bundle persisted before an
 *   identity component existed carries it as `unknown`, never as `none` (#1096
 *   §8 rule 3, §4.4 rule 5) — which by the matching law makes it valid for
 *   nothing, the conservative answer. A `not-run` record persisted without a
 *   recognized cause reads as `evidence-lost` (#1094 §6.2's `notRunKind`),
 *   which is the cause that credits the least. Both are *read* coercions: a
 *   write that cannot name the component or the cause is refused. Every other
 *   malformed field fails closed, refusing the read rather than coercing it.
 * - **Nothing is backfilled.** A task that predates the feature has no stage
 *   state and that reads as "no stage has run", which is exactly true (#1096 §8
 *   rule 2). Legacy `verificationNames` / `verificationPassed` context is never
 *   converted into a bundle, an identity, a pass or a pin.
 */

import { createHash } from "crypto";

import {
  issueBaseRecordProblem,
  isPersistableTestFileId,
  MAX_RETAINED_TEST_FILES,
  nextRetainedTestFiles,
  persistedIssueBase,
  readRetainedTestFileSet,
  testStageRecordProblem,
  type IssueBaseRecord,
  type RetainedTestFile,
  type RetainedTestFilesRead,
  type TestStageRecord,
} from "./changed-test-file-selection.js";
// Value import, and safe in this direction only: `final-stage-gate.ts` is
// deliberately value-import-free of this cluster (see its header), so nothing
// here closes a cycle — and this module already reaches it at runtime through
// `verification-amendment.ts` -> `outbox-effects.ts`. Only the context key is
// taken; none of the gate's decisions are read here.
import { FINAL_STAGE_APPROVAL_CONTEXT_KEY } from "./final-stage-gate.js";
import type { AiTask, StoreResult, TaskEvent, TaskKey } from "./task.js";
import type { OutboxEffect, TaskStore } from "./task-store.js";
import {
  canonicalJsonStringify,
  MAX_VERIFICATION_AMENDMENT_OPERATIONS,
  MAX_VERIFICATION_AMENDMENT_REVISIONS,
  MAX_VERIFICATION_SESSION_BASELINE_ENTRIES,
} from "./verification-amendment.js";
import { MAX_VERIFICATION_PLAN_REQUIREMENTS } from "./verification-plan.js";
import {
  CHECK_NOT_RUN_KINDS,
  type CheckExecutionRecord,
  type CheckVerdict,
} from "./verification-result.js";

// ---------------------------------------------------------------------------
// The closed vocabularies
// ---------------------------------------------------------------------------

/**
 * `docs/verification-execution-contract.md` §2's closed lane set, mirrored here
 * because #918's engine — which owns the type — is unimplemented and a stage
 * run is keyed by its lane. Successor slices import this rather than declaring
 * a second copy; adding a lane is a change to #918's document first.
 */
export const VERIFICATION_LANES = [
  "implementation",
  "review",
  "conflict-resolution",
  "tool-request-continuation",
] as const;

export type VerificationLane = (typeof VERIFICATION_LANES)[number];

/** #1094 §2 and §4: the closed stage set. */
export const STAGE_IDS = ["loop", "final"] as const;

export type StageId = (typeof STAGE_IDS)[number];

/**
 * #1094 §6.1's closed stage outcome vocabulary. Recorded here, never derived
 * here: the precedence that maps a bundle's verdicts onto one of these belongs
 * to the stage model (S1).
 */
export const STAGE_OUTCOMES = [
  "passed",
  "code-failed",
  "timed-out",
  "interrupted",
  "unknown",
  "infrastructure",
] as const;

export type StageOutcome = (typeof STAGE_OUTCOMES)[number];

/**
 * #1096 §4.2's closed seven-component identity. The set is closed: adding a
 * component is a change to that document first, and a bundle carrying more or
 * fewer components than these seven is not a valid identity.
 */
export const STAGE_IDENTITY_COMPONENTS = [
  "testedRevision",
  "workingTreeState",
  "planDigest",
  "planRevisionOrdinal",
  "sessionBaselineDigest",
  "selectionPolicyDigest",
  "environmentIdentity",
] as const;

export type StageIdentityComponentName = (typeof STAGE_IDENTITY_COMPONENTS)[number];

/** #1094 §6.2's closed verdict set, as a list validation can iterate. */
const CHECK_VERDICTS: readonly CheckVerdict[] = [
  "passed",
  "failed",
  "timed-out",
  "not-run",
  "unknown",
];

/**
 * #1094 §6.2: the verdicts that say something about the change. A check
 * carrying any other verdict — `not-run` through an accounted absence, or
 * `unknown` through evidence loss — leaves the bundle incomplete.
 */
const TERMINAL_VERDICTS: readonly CheckVerdict[] = ["passed", "failed", "timed-out"];

// ---------------------------------------------------------------------------
// Keys, events and bounds
// ---------------------------------------------------------------------------

/**
 * The one task-context key this slice writes. One key, under the existing CAS,
 * beside #1038's `verificationAmendments` and #1040's
 * `manualVerificationEvidence` — no new store and no new table (#1094 §9).
 */
export const STAGED_VERIFICATION_CONTEXT_KEY = "stagedVerification";

/**
 * The newest persisted shape this runner reads. A block written by a NEWER
 * runner refuses the read rather than being coerced into this shape; a block
 * with no version at all is read as {@link STAGED_VERIFICATION_LEGACY_STATE_VERSION}.
 *
 * Version 2 (issue #1153) adds the Issue base, the retained test files and the
 * `testFiles` record on a bundle. A write stamps 2 only when the block carries
 * one of them, so a runner that predates them refuses the block instead of
 * reading it, rewriting it without them and dropping an Issue's obligations.
 */
export const STAGED_VERIFICATION_STATE_VERSION = 2;

/** The shape #1099–#1108 shipped, and what a block without a version reads as. */
export const STAGED_VERIFICATION_LEGACY_STATE_VERSION = 1;

export const STAGE_RUN_ALLOCATED_EVENT = "verification.stage.allocated";
export const STAGE_RUN_RECORDED_EVENT = "verification.stage.recorded";

/** Bound on the per-run ledger. Newest entries win; an allocation never drops. */
export const MAX_STAGE_RUN_LEDGER_ENTRIES = 50;

/**
 * Bound on the per-(attempt, lane, stage) ordinal cursors kept on a task. The
 * live cursor of each (lane, stage) is never evicted by it (see
 * {@link pruneOrdinalCursors}).
 */
export const MAX_STAGE_ORDINAL_CURSORS = 64;

/**
 * Bound on one bundle's `checks[]` and on its selection's `checkIds[]`. A final
 * stage runs every slot the effective plan holds, so the only bound that cannot
 * refuse evidence for a plan the runner itself accepts is the plan's own
 * ceiling: #1039's requirement layer, #1038's session layer, and the slots an
 * amendment chain can add — at most one per recorded operation, since a
 * colliding `add` materializes nothing. Anything above that could not have come
 * out of `resolveEffectiveVerificationPlan`, so it is corruption, not a plan.
 */
export const MAX_STAGE_BUNDLE_CHECKS =
  MAX_VERIFICATION_PLAN_REQUIREMENTS +
  MAX_VERIFICATION_SESSION_BASELINE_ENTRIES +
  MAX_VERIFICATION_AMENDMENT_REVISIONS * MAX_VERIFICATION_AMENDMENT_OPERATIONS;

/** Bound on operator-facing text recorded here: reasons, sources, request keys. */
export const MAX_STAGE_TEXT_CHARS = 512;

// ---------------------------------------------------------------------------
// The persisted shapes
// ---------------------------------------------------------------------------

/**
 * #1096 §4.1's three-valued component. `none` is a fact about the
 * configuration and compares equal to another `none`; `unknown` is the absence
 * of knowledge and compares equal to nothing, including itself. A failure to
 * resolve is always `unknown` and never `none`.
 *
 * The matching law over these lives in the stage model (S1); this module
 * records and validates the states and never compares two of them for
 * admissibility.
 */
export type IdentityComponent =
  | { readonly state: "value"; readonly value: string }
  | { readonly state: "none"; readonly source: string }
  | { readonly state: "unknown"; readonly reason: string };

/** #1096 §4.2: one stage run's identity — all seven components, always. */
export type StageEvidenceIdentity = Readonly<
  Record<StageIdentityComponentName, IdentityComponent>
>;

/** #1094 §2: the stage run's identity tuple, and #1096 §7.1's idempotency key. */
export interface StageRunId {
  readonly taskAttempt: number;
  readonly lane: VerificationLane;
  readonly stage: StageId;
  /** #1094 §2: starts at 0 per attempt, lane and stage. */
  readonly stageOrdinal: number;
}

/**
 * What checks this run covered, and whether that was the whole required set.
 *
 * Issue #1155 retired the selection policy, so there is no `source` and no port
 * reason left to record: a stage covers the entire required set, and `full` is
 * false only when the bound test suite entry left it for Stage 1 / Stage 2
 * (`docs/changed-file-verification-contract.md` §6 rule 2).
 */
export interface StageSelectionRecord {
  /** Ordered as executed. Every id appears exactly once. */
  readonly checkIds: readonly string[];
  /** {@link deriveStageSelectionDigest} over the ids. Membership, not order. */
  readonly selectionDigest: string;
  /** True iff `checkIds` is the full required set, as the caller resolved it. */
  readonly full: boolean;
}

/**
 * #1094 §6.2's stage evidence bundle, with #1096 §4.2's identity on it.
 *
 * Written once, never edited: an invalid or partial bundle is retained with the
 * identity that invalidated it rather than repaired or deleted (#1096 §4.4 rule
 * 3, §10 invariant 5).
 */
export interface StageRunResult {
  readonly stageRunId: StageRunId;
  /** #1039 `EffectiveVerificationPlan.planDigest`, as resolved for this run. */
  readonly planDigest: string;
  /** The head the stage ran against. */
  readonly headSha?: string;
  readonly selection: StageSelectionRecord;
  readonly outcome: StageOutcome;
  /** False when any selected check lacks a terminal verdict (§6.2 rule 1). */
  readonly complete: boolean;
  readonly checks: readonly CheckExecutionRecord[];
  /** #1096 §4.3 rule 1: resolved at launch, before the first check started. */
  readonly identity: StageEvidenceIdentity;
  /** #1096 §4.3 rule 3: the end-of-run re-resolution, when the caller made one. */
  readonly identityRecheck?: StageEvidenceIdentity;
  /** Allocation timestamp, carried from the ledger entry. */
  readonly startedAt: string;
  /** Stamped by the write. */
  readonly recordedAt: string;
  /** Runner-measured wall time of the stage run. */
  readonly durationMs?: number;
  /**
   * Issue #1153: the test-file half of the run (`loop` is Stage 1, `final` is
   * Stage 2) — its §3 result, selection, suite binding digest, outcome counts
   * and trusted failed files. Absent on every bundle of the check-group policy.
   */
  readonly testFiles?: TestStageRecord;
}

/**
 * The caller-supplied half of a bundle. The launch identity and both
 * timestamps are stamped by {@link recordStageRun} from the allocation, so a
 * bundle can only ever carry the identity its own run started with.
 */
export type StageRunResultInput = Omit<
  StageRunResult,
  "identity" | "startedAt" | "recordedAt"
>;

/**
 * #1096 §7.1's two observable states, plus the third thing a *reader* may
 * conclude: an allocation a later allocation superseded is `interrupted`.
 *
 * The ledger is what makes a crash detectable after a restart. It carries no
 * output bytes, no command bytes and no paths — the bundle holds those.
 */
export interface StageRunLedgerEntry {
  readonly stageRunId: StageRunId;
  /** The caller's idempotency key for the ALLOCATION (§7.1 rule 6). */
  readonly requestKey: string;
  readonly identity: StageEvidenceIdentity;
  readonly allocatedAt: string;
  readonly state: "allocated" | "recorded" | "interrupted";
  readonly recordedAt?: string;
  /** Set when `state` is `recorded`. Mirrors the bundle. */
  readonly outcome?: StageOutcome;
  readonly complete?: boolean;
  /** Set when `state` is `interrupted`: when the supersession was observed. */
  readonly interruptedAt?: string;
}

/** #1096 §7.1 rule 2: ordinals advance per launched run and are never reused. */
export interface StageOrdinalCursor {
  readonly taskAttempt: number;
  readonly lane: VerificationLane;
  readonly stage: StageId;
  /**
   * The ordinal this key last handed out. #1094 §2's first ordinal is 0, so the
   * absence of the cursor — never a zero in it — is what marks a key that has
   * not allocated yet.
   */
  readonly lastOrdinal: number;
}

/**
 * The whole block under {@link STAGED_VERIFICATION_CONTEXT_KEY}.
 *
 * Retention is #1094 §6.3's floor, expressed as the shape itself: one loop
 * bundle per lane (R3), the most recent final bundle (R4), the bundle that
 * actually produced the live stack-ready grant (R1) and the most recent
 * complete, passing, full-set final bundle beside it are what the write keeps.
 * No pruning policy shortens them (R5). Issue #1155 removed R3's one exception
 * with #1094 §7 row 5's full-set re-run of a first `unknown` loop stage.
 */
export interface StagedVerificationState {
  readonly version: number;
  readonly ordinals: readonly StageOrdinalCursor[];
  readonly runs: readonly StageRunLedgerEntry[];
  /** At most one entry per lane (R3). */
  readonly loopBundles: readonly StageRunResult[];
  /**
   * The most recent final bundle, the R1 bundle behind the live grant, and the
   * most recent granting-shaped one — at most three, deduplicated.
   */
  readonly finalBundles: readonly StageRunResult[];
  /**
   * {@link stageRunKey} of the final bundle whose recording transaction
   * enqueued the live stack-ready grant (#1094 §8 step 5).
   *
   * Kept as a key rather than as a second copy of the bundle: the bundle itself
   * stays in `finalBundles`, and one pointer cannot drift from it. Absent on
   * every task whose grant was never recorded through this module — including
   * every legacy row (#1096 §8) — which is why nothing infers a grant from its
   * absence.
   */
  readonly grantingStageRunKey?: string;
  /**
   * Consecutive non-code terminations of the review lane's final stage — the
   * #1096 §7.3 rule 5 counter `maxStageRecoveryAttempts` bounds.
   *
   * Persisted rather than reconstructed from `runs`: the ledger is pruned to
   * {@link MAX_STAGE_RUN_LEDGER_ENTRIES}, so a streak read back from it could
   * never exceed the window and a budget at or above it would never park. A
   * grant or a code verdict (`code-failed`, `timed-out`, `unknown`) resets it;
   * absent reads as zero.
   */
  readonly finalRecoveryStreak?: number;
  /**
   * Issue #1153 (`docs/changed-file-verification-contract.md` §4.1 rule 1): the
   * one commit this Issue's cumulative diff is taken from, persisted by the
   * first Stage 1 record whose selection was known and never rewritten.
   */
  readonly issueBase?: IssueBaseRecord;
  /**
   * Issue #1153 (§4.3): the Issue's retained failing test files, each with the
   * Stage 2 run that added it. Only a `failed` Stage 2 with trusted outcomes
   * adds; nothing removes an entry before the Issue completes. Absent reads as
   * empty.
   */
  readonly retainedTestFiles?: readonly RetainedTestFile[];
  /**
   * Set when a union exceeded {@link MAX_RETAINED_TEST_FILES}. Sticky: the set
   * then reads unreadable for every later selection. Absent reads as false.
   */
  readonly retainedTestFilesOverflowed?: true;
}

/**
 * The version a write stamps: {@link STAGED_VERIFICATION_STATE_VERSION} when the
 * block carries anything version 1 cannot express, otherwise the legacy version
 * so an unchanged task stays readable by the runner that shipped it.
 */
function stagedVerificationStateVersion(state: StagedVerificationState): number {
  return carriesTestFileState(state) ? STAGED_VERIFICATION_STATE_VERSION : STAGED_VERIFICATION_LEGACY_STATE_VERSION;
}

/**
 * Has this task entered the Issue #1153 test-file flow — an Issue base, a
 * retained obligation, or any bundle with a test-file record?
 *
 * A block already stamped version 2 has, even when the record that entered the
 * flow has since been evicted (an `unavailable` Stage 1 bundle whose base did not
 * resolve sets no base and retains nothing): the version is the durable marker, so a later bundle
 * without a test-file record can neither downgrade the block nor grant.
 */
function carriesTestFileState(state: StagedVerificationState): boolean {
  return (
    state.version >= STAGED_VERIFICATION_STATE_VERSION
    || state.issueBase !== undefined
    || (state.retainedTestFiles?.length ?? 0) > 0
    || state.retainedTestFilesOverflowed === true
    || [...state.loopBundles, ...state.finalBundles].some((bundle) => bundle.testFiles !== undefined)
  );
}

/**
 * Issue #1153: the retained set as a Stage 1 selection reads it — unreadable
 * once it has overflowed, so a missing obligation never reads as absent.
 */
export function retainedTestFilesRead(state: StagedVerificationState | undefined): RetainedTestFilesRead {
  return readRetainedTestFileSet({
    files: state?.retainedTestFiles ?? [],
    overflowed: state?.retainedTestFilesOverflowed === true,
  });
}

/**
 * The next state's Issue base after recording `bundle`: set by the first Stage 1
 * selection whose base resolved — known, or unavailable only for a later input,
 * so a retry never resolves the base again (§4.1 rule 1) — advanced by a Stage 1
 * selection that declares an accepted predecessor update off a recorded
 * `dependency-base` (decision D5), or a refusal when the bundle names a
 * different one, declares nothing, declares an advance off a base that was
 * never resolved against a predecessor, or declares an advance while naming the
 * base that is already recorded.
 *
 * `advanced` is what the caller invalidates earlier stage and review evidence
 * on: the Issue's cumulative diff is taken from a different commit from here on,
 * so nothing recorded against the old base may be reused.
 */
function nextIssueBase(
  prior: IssueBaseRecord | undefined,
  bundle: StageRunResult,
): { base?: IssueBaseRecord; advanced?: true; problem?: string } {
  const named = bundle.testFiles?.selection;
  const issueBase = named?.status === "known" || named?.status === "unavailable" ? named.issueBase : undefined;
  if (issueBase === undefined) return prior ? { base: prior } : {};
  const next = persistedIssueBase(issueBase);
  const declared = issueBase.advancedFrom;
  if (prior === undefined) {
    if (declared !== undefined) {
      return {
        problem:
          `bundle.testFiles.selection.issueBase.advancedFrom: names ${declared.source} ${declared.sha}, `
          + "but this task has no recorded Issue base to advance",
      };
    }
    return { base: next };
  }
  if (prior.sha === next.sha && prior.source === next.source) {
    // The bundle names the base already recorded, so nothing moved — and a
    // declaration here contradicts that. A stale advance computed before
    // another run moved the base onto this very commit would otherwise be
    // admitted without setting `advanced`, leaving a persisted selection that
    // claims a re-base while the evidence and the approval it claims to
    // replace stay valid. An unchanged base declares nothing (§4.1 rule 1, D5).
    if (declared !== undefined) {
      return {
        problem:
          `bundle.testFiles.selection.issueBase.advancedFrom: declares ${declared.source} ${declared.sha}, but the `
          + `Issue base is unchanged at ${prior.source} ${prior.sha}; a selection that moves no base declares no `
          + "advance (§4.1 rule 1, D5)",
      };
    }
    return { base: prior };
  }
  // D5: only a declared advance off exactly the recorded base moves it. A
  // selection that names another commit without declaring what it replaces —
  // everything a moved ref or a bare fetch can produce — is refused.
  if (declared !== undefined && declared.sha === prior.sha && declared.source === prior.source) {
    // §4.1 rule 1: "A base this contract never resolved against a predecessor
    // never advances." `resolveIssueBase` never declares such an advance; this
    // is the persisted half of the same rule, so no other caller can write one.
    if (prior.source !== "dependency-base") {
      return {
        problem:
          `bundle.testFiles.selection.issueBase.advancedFrom: declares ${declared.source} ${declared.sha}, but a base `
          + "this contract never resolved against a predecessor never advances (§4.1 rule 1, D5)",
      };
    }
    return { base: next, advanced: true };
  }
  return {
    problem:
      `bundle.testFiles.selection.issueBase: ${next.source} ${next.sha} differs from `
      + `the recorded Issue base ${prior.source} ${prior.sha}; a recorded base moves only on a Stage 1 selection `
      + "that declares the accepted predecessor update it replaces (§4.1 rule 1, D5)",
  };
}

/**
 * The next {@link StagedVerificationState.finalRecoveryStreak} after one
 * review-lane final run ends — omitted when the streak is broken.
 */
function nextFinalRecoveryStreak(
  state: StagedVerificationState,
  reset: boolean,
): Pick<StagedVerificationState, "finalRecoveryStreak"> {
  return reset ? {} : { finalRecoveryStreak: (state.finalRecoveryStreak ?? 0) + 1 };
}

function isReviewFinalRun(stageRunId: StageRunId): boolean {
  return stageRunId.lane === "review" && stageRunId.stage === "final";
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STAGE_TEXT_CHARS;
}

/** The ledger's and the idempotency check's flat form of a {@link StageRunId}. */
export function stageRunKey(stageRunId: StageRunId): string {
  return `${stageRunId.taskAttempt}/${stageRunId.lane}/${stageRunId.stage}/${stageRunId.stageOrdinal}`;
}

export function sameStageRunId(a: StageRunId, b: StageRunId): boolean {
  return stageRunKey(a) === stageRunKey(b);
}

/** #1096 §4.1 rule 1: every failure to resolve is `unknown`, never `none`. */
export function unknownIdentityComponent(reason: string): IdentityComponent {
  return { state: "unknown", reason: reason.slice(0, MAX_STAGE_TEXT_CHARS) };
}

/**
 * #1096 §4.4: `value`/`value` matches on equal values, `none` matches `none`,
 * and `unknown` matches nothing — including another `unknown`.
 *
 * The last clause is the deliberate divergence from #916 §9 rule 5, which
 * resolves an unknown *capability* to absent. For a capability, absent is the
 * conservative reading; for an identity it is the dangerous one, because it
 * makes an unattestable run compare equal to an unattested one. Both contracts
 * fail closed, in opposite directions, because they answer opposite questions.
 *
 * It lives here, and `stage-evidence-validity.ts` re-exports it, so the one
 * implementation of the law also serves {@link recordStageRun}'s grant guard
 * without an import cycle.
 */
export function matchIdentityComponent(
  expected: IdentityComponent,
  evidence: IdentityComponent,
): boolean {
  if (expected.state === "unknown" || evidence.state === "unknown") return false;
  if (expected.state === "none") return evidence.state === "none";
  if (evidence.state !== "value") return false;
  return expected.value === evidence.value;
}

/**
 * #1096 §8 rule 3 / §4.4 rule 5: evidence persisted before a component existed
 * carries it as `unknown`. The run happened under *some* policy and *some*
 * environment and the runner cannot retroactively attest which, so the whole
 * tuple reads unknown and the bundle is valid for nothing.
 */
export function legacyStageEvidenceIdentity(reason = "legacy-record"): StageEvidenceIdentity {
  const identity: Partial<Record<StageIdentityComponentName, IdentityComponent>> = {};
  for (const name of STAGE_IDENTITY_COMPONENTS) {
    identity[name] = unknownIdentityComponent(reason);
  }
  return identity as StageEvidenceIdentity;
}

/**
 * #1094 §6.2: sha256 over the selection's ids.
 *
 * Over the **sorted** ids, deliberately: §14 requires the digest to change with
 * membership and not with resolution order, so two runs that chose the same
 * checks — one because the port proposed them in a different order, one because
 * a regression union reordered them — are recognizably the same scope. The
 * executed order is preserved in `checkIds`, which is where order belongs.
 */
export function deriveStageSelectionDigest(checkIds: readonly string[]): string {
  const sorted = [...checkIds].sort();
  return createHash("sha256").update(canonicalJsonStringify(sorted)).digest("hex");
}

/**
 * #1094 §6.2 rule 1 and rule 3: a bundle is complete only when every selected
 * check carries a terminal verdict. An accounted absence — a fail-fast skip, a
 * requirement the run did not prove — is still an absence: it changes which row
 * the run routes through and never what it proved.
 */
export function deriveStageBundleCompleteness(
  checkIds: readonly string[],
  checks: readonly Pick<CheckExecutionRecord, "checkId" | "verdict">[],
): boolean {
  const verdicts = new Map(checks.map((check) => [check.checkId, check.verdict]));
  return checkIds.every((checkId) => {
    const verdict = verdicts.get(checkId);
    return verdict !== undefined && TERMINAL_VERDICTS.includes(verdict);
  });
}

/** The retained bundle for a stage, optionally narrowed to one lane. */
export function latestStageBundle(
  state: StagedVerificationState | undefined,
  stage: StageId,
  lane?: VerificationLane,
): StageRunResult | undefined {
  if (!state) return undefined;
  const bundles = stage === "loop" ? state.loopBundles : state.finalBundles;
  const matching = bundles.filter(
    (bundle) => lane === undefined || bundle.stageRunId.lane === lane,
  );
  return matching[matching.length - 1];
}

/**
 * #1094 §4.3 with §6.2 rules 1 and 4: the shape of a final bundle row 7 could
 * grant against.
 *
 * Completeness and a `passed` outcome are not enough. Both are statements about
 * the checks this run *selected*; a final run whose selection was anything less
 * than the whole required set is a partial bundle by definition and can never
 * contribute to a grant, however green its own selected checks came back.
 * `selection.full` is what makes that scope recognizable (§6.2 rule 1), so it is
 * read here rather than inferred from the outcome.
 */
function isGrantingShapedFinalBundle(bundle: StageRunResult): boolean {
  return bundle.complete && bundle.outcome === "passed" && bundle.selection.full;
}

/**
 * The most recent complete, `passed`, full-set final bundle this task retains.
 * It is the only *shape* #1094 row 7 could ever grant against — which is why
 * the write keeps it even after a later final run supersedes it.
 *
 * Being granting-shaped is not the same as having granted: the bundle a live
 * marker actually rests on is {@link grantingFinalBundle}, and the two differ
 * whenever a later full-set run passed without publishing a replacement grant.
 *
 * Returning one is not admission: #1096 §4.4 validity is the stage model's
 * comparison, not this module's.
 */
export function lastPassedFinalBundle(
  state: StagedVerificationState | undefined,
): StageRunResult | undefined {
  if (!state) return undefined;
  const granting = state.finalBundles.filter(isGrantingShapedFinalBundle);
  return granting[granting.length - 1];
}

/**
 * The R1 bundle: the final bundle whose own recording transaction enqueued the
 * stack-ready grant this task is still carrying (#1094 §6.3 R1).
 *
 * `undefined` means no grant was ever recorded through this module for this
 * task — not that the marker is gone. Nothing here observes the label itself;
 * the pointer records what the runner published beside the evidence, which is
 * the only fact the same transaction establishes.
 */
export function grantingFinalBundle(
  state: StagedVerificationState | undefined,
): StageRunResult | undefined {
  const key = state?.grantingStageRunKey;
  if (!state || key === undefined) return undefined;
  return state.finalBundles.find((bundle) => stageRunKey(bundle.stageRunId) === key);
}

/**
 * #1096 §7.1 rule 4: an allocated ordinal with no committed bundle. The one
 * thing a reader may conclude about it is that the run was interrupted — it is
 * never resumed and never partially credited.
 *
 * Issue #1155 removed the loop stage's automatic re-run over the interrupted
 * ordinal along with the selection policy it existed to widen, so the routing
 * that follows this is #1154's D1: `openStageRunGuard` parks the open
 * allocation for an operator. This reader stays, because #1096 §7.1 rule 4 is
 * not a selection rule — the status view reports the open run from it.
 */
export function pendingStageRunInterruption(
  state: StagedVerificationState | undefined,
): StageRunLedgerEntry | undefined {
  return state?.runs.find((entry) => entry.state === "allocated");
}

/** The ledger entry for one stage run, whatever state it reached. */
export function stageRunLedgerEntry(
  state: StagedVerificationState | undefined,
  stageRunId: StageRunId,
): StageRunLedgerEntry | undefined {
  const key = stageRunKey(stageRunId);
  return state?.runs.find((entry) => stageRunKey(entry.stageRunId) === key);
}

/** The committed bundle for one stage run, while retention still holds it. */
export function stageRunBundle(
  state: StagedVerificationState | undefined,
  stageRunId: StageRunId,
): StageRunResult | undefined {
  if (!state) return undefined;
  const key = stageRunKey(stageRunId);
  return [...state.loopBundles, ...state.finalBundles].find(
    (bundle) => stageRunKey(bundle.stageRunId) === key,
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Which side of the asymmetry a validation runs on. `write` is the strict one:
 * a caller producing a record now can name everything the contracts require of
 * it. `read` is the one that has to live with rows written before a field
 * existed, and coerces exactly the two the contracts say coerce — never more.
 */
type ValidationMode = "write" | "read";

function identityComponentProblem(value: unknown, path: string): string | undefined {
  if (!isPlainObject(value)) return `${path}: not an object`;
  if (value.state === "value") {
    return typeof value.value === "string" && value.value.length > 0
      ? undefined
      : `${path}.value: not a non-empty string`;
  }
  if (value.state === "none") {
    return isBoundedText(value.source) ? undefined : `${path}.source: not bounded text`;
  }
  if (value.state === "unknown") {
    return isBoundedText(value.reason) ? undefined : `${path}.reason: not bounded text`;
  }
  return `${path}.state: not one of value | none | unknown`;
}

/**
 * The write-side identity check: all seven components, each well formed.
 * A caller that cannot resolve a component supplies `unknown` with its reason
 * (#1096 §4.1 rule 1) — it never omits it.
 */
function identityProblem(value: unknown, path: string): string | undefined {
  if (!isPlainObject(value)) return `${path}: not an object`;
  for (const name of STAGE_IDENTITY_COMPONENTS) {
    const problem = identityComponentProblem(value[name], `${path}.${name}`);
    if (problem) return problem;
  }
  for (const key of Object.keys(value)) {
    if (!(STAGE_IDENTITY_COMPONENTS as readonly string[]).includes(key)) {
      return `${path}.${key}: not one of the seven closed components (#1096 §4.2)`;
    }
  }
  return undefined;
}

/**
 * The read-side identity coercion, and the module's one soft failure.
 *
 * A stored identity that is absent, short a component, or carrying a component
 * the reader cannot parse reads `unknown` for whatever it cannot establish
 * (#1096 §8 rule 3). That is the fail-closed answer, not a lenient one: by the
 * matching law an `unknown` component matches nothing, so such a bundle can
 * never be valid for a use — while refusing the whole read would instead hide
 * evidence an operator is entitled to see (§4.4 rule 3).
 */
function normalizeStoredIdentity(value: unknown): StageEvidenceIdentity {
  const identity: Partial<Record<StageIdentityComponentName, IdentityComponent>> = {};
  const stored = isPlainObject(value) ? value : undefined;
  for (const name of STAGE_IDENTITY_COMPONENTS) {
    const component = stored?.[name];
    if (component === undefined) {
      identity[name] = unknownIdentityComponent("legacy-record");
      continue;
    }
    identity[name] = identityComponentProblem(component, name)
      ? unknownIdentityComponent("unreadable-record")
      : (component as IdentityComponent);
  }
  return identity as StageEvidenceIdentity;
}

/**
 * The read-side cause coercion, and the module's second soft failure.
 *
 * #1094 §6.2's `notRunKind` is a closed set whose absent and unrecognized cases
 * both read `evidence-lost` — a run that cannot say why a check went unproven
 * has lost the evidence either way, and `evidence-lost` is the cause that
 * credits the least. Coercing on the read is what keeps a row written before
 * the cause was required legible without letting a live writer drop it: the
 * write refuses that record (see {@link checkRecordProblem}).
 */
function normalizeStoredChecks(
  checks: readonly CheckExecutionRecord[],
): readonly CheckExecutionRecord[] {
  return checks.map((check) => {
    if (check.verdict !== "not-run") return check;
    if ((CHECK_NOT_RUN_KINDS as readonly unknown[]).includes(check.notRunKind)) return check;
    return { ...check, notRunKind: "evidence-lost" as const };
  });
}

function stageRunIdProblem(value: unknown, path: string): string | undefined {
  if (!isPlainObject(value)) return `${path}: not an object`;
  if (!isNonNegativeInteger(value.taskAttempt)) {
    return `${path}.taskAttempt: not a non-negative integer`;
  }
  if (!(VERIFICATION_LANES as readonly unknown[]).includes(value.lane)) {
    return `${path}.lane: not one of the closed lane set`;
  }
  if (!(STAGE_IDS as readonly unknown[]).includes(value.stage)) {
    return `${path}.stage: not one of the closed stage set`;
  }
  // #1094 §2: the ordinal starts at 0 per attempt, lane and stage, so 0 is the
  // first run's ordinal and not a missing one.
  if (!isNonNegativeInteger(value.stageOrdinal)) {
    return `${path}.stageOrdinal: not a non-negative integer`;
  }
  return undefined;
}

function checkRecordProblem(
  value: unknown,
  path: string,
  mode: ValidationMode,
): string | undefined {
  if (!isPlainObject(value)) return `${path}: not an object`;
  if (typeof value.checkId !== "string" || value.checkId.length === 0) {
    return `${path}.checkId: not a non-empty string`;
  }
  if (!CHECK_VERDICTS.includes(value.verdict as CheckVerdict)) {
    return `${path}.verdict: not one of the closed verdict set`;
  }
  // #1094 §6.2's `checks[]`: a `not-run` record carries the cause, because the
  // cause is what decides whether the absence is an accounted skip or lost
  // evidence — two facts that route to different outcomes. A caller that cannot
  // name one is producing evidence nobody can interpret, so the WRITE is
  // refused; a stored record that lacks one, or carries a cause this reader
  // does not recognize, is a legacy row and reads `evidence-lost` (see
  // {@link normalizeStoredChecks}) rather than costing the operator the whole
  // bundle.
  if (value.verdict === "not-run") {
    if (mode === "write" && !(CHECK_NOT_RUN_KINDS as readonly unknown[]).includes(value.notRunKind)) {
      return value.notRunKind === undefined
        ? `${path}.notRunKind: absent on a "not-run" verdict (#1094 §6.2)`
        : `${path}.notRunKind: not one of the closed cause set`;
    }
  } else if (value.notRunKind !== undefined) {
    return `${path}.notRunKind: recorded for a check that has a verdict`;
  }
  if (value.durationMs !== undefined && !isNonNegativeInteger(value.durationMs)) {
    return `${path}.durationMs: not a non-negative integer`;
  }
  if (value.exitCode !== undefined && !Number.isInteger(value.exitCode)) {
    return `${path}.exitCode: not an integer`;
  }
  if (value.notRunReason !== undefined && !isBoundedText(value.notRunReason)) {
    return `${path}.notRunReason: not bounded text`;
  }
  return undefined;
}

function selectionProblem(value: unknown, path: string): string | undefined {
  if (!isPlainObject(value)) return `${path}: not an object`;
  const checkIds = value.checkIds;
  // An EMPTY selection is admissible, deliberately: a session that configures
  // no verification command has an empty required set, and an empty final
  // selection over it is an honest record of that. What such a bundle buys is
  // not this module's call — the row-7 precondition and the stage model read
  // `full`, the ids and the plan; persistence refusing it here would be the
  // persistence layer deciding what an empty plan means.
  if (!Array.isArray(checkIds)) return `${path}.checkIds: not an array`;
  if (checkIds.length > MAX_STAGE_BUNDLE_CHECKS) {
    return `${path}.checkIds: ${checkIds.length} entries exceeds the ${MAX_STAGE_BUNDLE_CHECKS}-check bound`;
  }
  const seen = new Set<string>();
  for (let i = 0; i < checkIds.length; i += 1) {
    const checkId: unknown = checkIds[i];
    if (typeof checkId !== "string" || checkId.length === 0) {
      return `${path}.checkIds[${i}]: not a non-empty string`;
    }
    if (seen.has(checkId)) return `${path}.checkIds[${i}]: duplicate id`;
    seen.add(checkId);
  }
  if (typeof value.full !== "boolean") return `${path}.full: not a boolean`;
  const digest = deriveStageSelectionDigest(checkIds as readonly string[]);
  if (value.selectionDigest !== digest) {
    return `${path}.selectionDigest: does not cover the recorded checkIds`;
  }
  return undefined;
}

/**
 * The bundle integrity rules that persistence itself owns. They are all
 * "the record must not claim more than it carries":
 *
 * - every selected check appears exactly once, and nothing else does (§6.2
 *   rules 1 and 3 — a bundle records its own scope);
 * - `complete` is exactly the derivation over those verdicts, so no write and
 *   no legacy row can mark a stage complete that is not (§6.2 rule 4);
 * - a `passed` bundle is a complete one in which every check passed, and an
 *   `interrupted` one is never complete (§6.1, §6.2 rule 4);
 * - a `passed` bundle carrying a test-file record carries a passing one
 *   (`passed`, or `empty` in Stage 1).
 *
 * The precedence that picks `outcome` out of the verdicts is NOT checked here;
 * that is the stage model's, and duplicating it would create a second copy to
 * drift.
 */
function bundleProblem(value: unknown, path: string, mode: ValidationMode): string | undefined {
  if (!isPlainObject(value)) return `${path}: not an object`;
  const stageRunIssue = stageRunIdProblem(value.stageRunId, `${path}.stageRunId`);
  if (stageRunIssue) return stageRunIssue;
  if (typeof value.planDigest !== "string" || value.planDigest.length === 0) {
    return `${path}.planDigest: not a non-empty string`;
  }
  if (value.headSha !== undefined && (typeof value.headSha !== "string" || value.headSha.length === 0)) {
    return `${path}.headSha: not a non-empty string`;
  }
  const selectionIssue = selectionProblem(value.selection, `${path}.selection`);
  if (selectionIssue) return selectionIssue;
  if (!(STAGE_OUTCOMES as readonly unknown[]).includes(value.outcome)) {
    return `${path}.outcome: not one of the closed outcome set`;
  }
  if (typeof value.complete !== "boolean") return `${path}.complete: not a boolean`;
  const checks = value.checks;
  if (!Array.isArray(checks)) return `${path}.checks: not an array`;
  if (checks.length > MAX_STAGE_BUNDLE_CHECKS) {
    return `${path}.checks: ${checks.length} entries exceeds the ${MAX_STAGE_BUNDLE_CHECKS}-check bound`;
  }
  for (let i = 0; i < checks.length; i += 1) {
    const problem = checkRecordProblem(checks[i], `${path}.checks[${i}]`, mode);
    if (problem) return problem;
  }
  const selection = value.selection as unknown as StageSelectionRecord;
  const records = checks as unknown as readonly CheckExecutionRecord[];
  const recorded = new Set<string>();
  // Membership over a set, not a scan: the bound is the whole effective plan's
  // ceiling, so a linear lookup here would be quadratic in a full stage.
  const selected = new Set(selection.checkIds);
  for (const record of records) {
    if (recorded.has(record.checkId)) {
      return `${path}.checks: duplicate record for ${record.checkId}`;
    }
    recorded.add(record.checkId);
    if (!selected.has(record.checkId)) {
      return `${path}.checks: ${record.checkId} is not in this run's selection`;
    }
  }
  const complete = deriveStageBundleCompleteness(selection.checkIds, records);
  if (value.complete !== complete) {
    return `${path}.complete: ${String(value.complete)} contradicts the recorded verdicts (§6.2 rule 4)`;
  }
  if (value.outcome === "passed") {
    if (!complete) return `${path}.outcome: "passed" on an incomplete bundle (§6.2 rule 4)`;
    const unproven = records.find((record) => record.verdict !== "passed");
    if (unproven) {
      return `${path}.outcome: "passed" beside a ${unproven.verdict} verdict for ${unproven.checkId}`;
    }
  }
  if (value.outcome === "interrupted" && complete) {
    return `${path}.outcome: "interrupted" on a complete bundle (§6.2 rule 4)`;
  }
  if (typeof value.startedAt !== "string" || value.startedAt.length === 0) {
    return `${path}.startedAt: not a non-empty string`;
  }
  if (typeof value.recordedAt !== "string" || value.recordedAt.length === 0) {
    return `${path}.recordedAt: not a non-empty string`;
  }
  if (value.durationMs !== undefined && !isNonNegativeInteger(value.durationMs)) {
    return `${path}.durationMs: not a non-negative integer`;
  }
  // Issue #1153: the test-file record fails closed on both sides. It carries
  // the Issue's obligations, so a record this reader cannot interpret must not
  // be read as one that retained nothing.
  if (value.testFiles !== undefined) {
    const stage = (value.stageRunId as unknown as StageRunId).stage;
    const problem = testStageRecordProblem(value.testFiles, `${path}.testFiles`, stage);
    if (problem) return problem;
    // The legacy outcome is what `lastPassedFinalBundle` and the reuse gates
    // read, so a bundle whose test result is not a pass must not call itself one.
    const testResult = (value.testFiles as unknown as TestStageRecord).result;
    if (value.outcome === "passed" && testResult !== "passed" && !(stage === "loop" && testResult === "empty")) {
      return `${path}.outcome: "passed" beside a "${testResult}" test-file result`;
    }
  }
  return undefined;
}

function ledgerEntryProblem(value: unknown, path: string): string | undefined {
  if (!isPlainObject(value)) return `${path}: not an object`;
  const stageRunIssue = stageRunIdProblem(value.stageRunId, `${path}.stageRunId`);
  if (stageRunIssue) return stageRunIssue;
  if (!isBoundedText(value.requestKey)) return `${path}.requestKey: not bounded text`;
  if (typeof value.allocatedAt !== "string" || value.allocatedAt.length === 0) {
    return `${path}.allocatedAt: not a non-empty string`;
  }
  if (value.state !== "allocated" && value.state !== "recorded" && value.state !== "interrupted") {
    return `${path}.state: not one of allocated | recorded | interrupted`;
  }
  if (value.state === "recorded") {
    if (!(STAGE_OUTCOMES as readonly unknown[]).includes(value.outcome)) {
      return `${path}.outcome: absent or unrecognized on a recorded run`;
    }
    if (typeof value.complete !== "boolean") {
      return `${path}.complete: absent on a recorded run`;
    }
  }
  return undefined;
}

function ordinalCursorProblem(value: unknown, path: string): string | undefined {
  if (!isPlainObject(value)) return `${path}: not an object`;
  if (!isNonNegativeInteger(value.taskAttempt)) {
    return `${path}.taskAttempt: not a non-negative integer`;
  }
  if (!(VERIFICATION_LANES as readonly unknown[]).includes(value.lane)) {
    return `${path}.lane: not one of the closed lane set`;
  }
  if (!(STAGE_IDS as readonly unknown[]).includes(value.stage)) {
    return `${path}.stage: not one of the closed stage set`;
  }
  // A cursor records the ordinal last handed out, and #1094 §2's first ordinal
  // is 0 — so a lane that has allocated exactly once sits at 0.
  if (!isNonNegativeInteger(value.lastOrdinal)) {
    return `${path}.lastOrdinal: not a non-negative integer`;
  }
  return undefined;
}

export type StagedVerificationStateValidation =
  | { valid: true; state: StagedVerificationState | undefined }
  | { valid: false; detail: string };

/**
 * Validate the stored block under {@link STAGED_VERIFICATION_CONTEXT_KEY}.
 *
 * Absence is the initial state and is valid (#1096 §8 rule 2): a legacy task,
 * or one whose session never enabled the feature, reads as `state: undefined`
 * and keeps its shipped behavior. There is no backfill — no
 * `verificationNames` / `verificationPassed` value is read here, and no prior
 * pass becomes a bundle.
 *
 * Everything structural fails closed: an unknown lane or stage, a verdict
 * outside the closed set, a selection digest that does not cover its ids, a
 * completeness flag the verdicts contradict, two `allocated` runs, or a block
 * written by a newer runner. Identity is the single exception and coerces to
 * `unknown` (see {@link normalizeStoredIdentity}). Details name field paths
 * only — never command bytes, output, or operator prose.
 */
export function validateStagedVerificationState(
  value: unknown,
): StagedVerificationStateValidation {
  const path = STAGED_VERIFICATION_CONTEXT_KEY;
  if (value === undefined) return { valid: true, state: undefined };
  if (!isPlainObject(value)) return { valid: false, detail: `${path}: not an object` };

  const version = value.version === undefined ? STAGED_VERIFICATION_LEGACY_STATE_VERSION : value.version;
  if (!isNonNegativeInteger(version) || version < 1) {
    return { valid: false, detail: `${path}.version: not a positive integer` };
  }
  if (version > STAGED_VERIFICATION_STATE_VERSION) {
    return {
      valid: false,
      detail: `${path}.version: ${version} was written by a newer runner than this one (max ${STAGED_VERIFICATION_STATE_VERSION})`,
    };
  }

  const ordinals = value.ordinals ?? [];
  if (!Array.isArray(ordinals)) return { valid: false, detail: `${path}.ordinals: not an array` };
  const cursorKeys = new Set<string>();
  for (let i = 0; i < ordinals.length; i += 1) {
    const problem = ordinalCursorProblem(ordinals[i], `${path}.ordinals[${i}]`);
    if (problem) return { valid: false, detail: problem };
    const cursor = ordinals[i] as unknown as StageOrdinalCursor;
    const key = `${cursor.taskAttempt}/${cursor.lane}/${cursor.stage}`;
    if (cursorKeys.has(key)) {
      return { valid: false, detail: `${path}.ordinals[${i}]: duplicate cursor for ${key}` };
    }
    cursorKeys.add(key);
  }

  const runs = value.runs ?? [];
  if (!Array.isArray(runs)) return { valid: false, detail: `${path}.runs: not an array` };
  const runKeys = new Set<string>();
  let allocated = 0;
  const ledger: StageRunLedgerEntry[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    const problem = ledgerEntryProblem(runs[i], `${path}.runs[${i}]`);
    if (problem) return { valid: false, detail: problem };
    const entry = runs[i] as unknown as StageRunLedgerEntry;
    const key = stageRunKey(entry.stageRunId);
    if (runKeys.has(key)) {
      return { valid: false, detail: `${path}.runs[${i}]: duplicate stage run ${key}` };
    }
    runKeys.add(key);
    if (entry.state === "allocated") allocated += 1;
    ledger.push({ ...entry, identity: normalizeStoredIdentity((runs[i] as Record<string, unknown>).identity) });
  }
  if (allocated > 1) {
    // #1096 §7.1 rule 3: one run is in flight at a time. Two allocations with
    // no bundle between them means a write landed half applied, and guessing
    // which one is live is exactly the guess that could credit a run twice.
    return {
      valid: false,
      detail: `${path}.runs: ${allocated} runs are allocated at once — at most one may be in flight (#1096 §7.1)`,
    };
  }

  const loopBundles = value.loopBundles ?? [];
  if (!Array.isArray(loopBundles)) {
    return { valid: false, detail: `${path}.loopBundles: not an array` };
  }
  const finalBundles = value.finalBundles ?? [];
  if (!Array.isArray(finalBundles)) {
    return { valid: false, detail: `${path}.finalBundles: not an array` };
  }
  const bundles: { readonly list: unknown[]; readonly stage: StageId; readonly field: string }[] = [
    { list: loopBundles, stage: "loop", field: "loopBundles" },
    { list: finalBundles, stage: "final", field: "finalBundles" },
  ];
  const normalizedLoop: StageRunResult[] = [];
  const normalizedFinal: StageRunResult[] = [];
  for (const group of bundles) {
    for (let i = 0; i < group.list.length; i += 1) {
      const entryPath = `${path}.${group.field}[${i}]`;
      const problem = bundleProblem(group.list[i], entryPath, "read");
      if (problem) return { valid: false, detail: problem };
      const bundle = group.list[i] as unknown as StageRunResult;
      if (bundle.stageRunId.stage !== group.stage) {
        return {
          valid: false,
          detail: `${entryPath}.stageRunId.stage: "${bundle.stageRunId.stage}" stored under ${group.field}`,
        };
      }
      const raw = group.list[i] as Record<string, unknown>;
      const storedRecheck = raw.identityRecheck;
      const normalized: StageRunResult = {
        ...bundle,
        identity: normalizeStoredIdentity(raw.identity),
        // §6.2: a `not-run` record whose cause is missing or unrecognized reads
        // as `evidence-lost`, so a consumer never has to distinguish "no cause
        // recorded" from a cause it can act on.
        checks: normalizeStoredChecks(bundle.checks),
        // §8 rule 3 governs BOTH persisted identities. A recheck short a
        // component, or carrying one this reader cannot parse, reads `unknown`
        // for whatever it cannot establish rather than reaching a typed
        // consumer with a hole where a component belongs. Absence stays
        // absence: "no recheck was made" is a different fact from "the recheck
        // could not be read", and only the second one is `unknown`.
        ...(storedRecheck !== undefined
          ? { identityRecheck: normalizeStoredIdentity(storedRecheck) }
          : {}),
      };
      (group.stage === "loop" ? normalizedLoop : normalizedFinal).push(normalized);
    }
  }

  // The pointer is validated for shape only, and deliberately not for a bundle
  // it must resolve to: a stored key whose bundle is missing is a retention
  // violation that already happened, and failing the whole block closed would
  // turn it into a task that can no longer record evidence at all. It reads as
  // "no granting bundle retained", which is what {@link grantingFinalBundle}
  // reports and what a later grant replaces.
  const storedGrantingKey: unknown = value.grantingStageRunKey;
  if (storedGrantingKey !== undefined && !isBoundedText(storedGrantingKey)) {
    return { valid: false, detail: `${path}.grantingStageRunKey: not a non-empty string` };
  }
  const grantingStageRunKey: string | undefined =
    typeof storedGrantingKey === "string" ? storedGrantingKey : undefined;

  const storedStreak: unknown = value.finalRecoveryStreak;
  if (storedStreak !== undefined && !isNonNegativeInteger(storedStreak)) {
    return { valid: false, detail: `${path}.finalRecoveryStreak: not a non-negative integer` };
  }

  // Issue #1153: the Issue base and the retained set fail closed. An obligation
  // this reader cannot read is one it cannot honor, and reading it as absent
  // would select it away.
  const storedIssueBase: unknown = value.issueBase;
  if (storedIssueBase !== undefined) {
    const problem = issueBaseRecordProblem(storedIssueBase, `${path}.issueBase`);
    if (problem) return { valid: false, detail: problem };
  }
  const storedRetained: unknown = value.retainedTestFiles;
  if (storedRetained !== undefined) {
    if (!Array.isArray(storedRetained) || storedRetained.length > MAX_RETAINED_TEST_FILES) {
      return {
        valid: false,
        detail: `${path}.retainedTestFiles: not an array of at most ${MAX_RETAINED_TEST_FILES} entries`,
      };
    }
    const seen = new Set<string>();
    for (let i = 0; i < storedRetained.length; i += 1) {
      const entry: unknown = storedRetained[i];
      if (
        !isPlainObject(entry)
        || !isPersistableTestFileId(entry.file)
        || seen.has(entry.file)
        || !isBoundedText(entry.addedBy)
      ) {
        return {
          valid: false,
          detail: `${path}.retainedTestFiles[${i}]: not a distinct test file id with the run that added it`,
        };
      }
      seen.add(entry.file);
    }
  }
  const storedRetainedOverflow: unknown = value.retainedTestFilesOverflowed;
  if (storedRetainedOverflow !== undefined && typeof storedRetainedOverflow !== "boolean") {
    return { valid: false, detail: `${path}.retainedTestFilesOverflowed: not a boolean` };
  }
  const retainedTestFiles = (storedRetained as readonly RetainedTestFile[] | undefined) ?? [];

  return {
    valid: true,
    state: {
      version,
      ordinals: ordinals as unknown as readonly StageOrdinalCursor[],
      runs: ledger,
      loopBundles: normalizedLoop,
      finalBundles: normalizedFinal,
      ...(grantingStageRunKey !== undefined ? { grantingStageRunKey } : {}),
      ...(typeof storedStreak === "number" && storedStreak > 0
        ? { finalRecoveryStreak: storedStreak }
        : {}),
      // The persisted base never keeps the advance that produced it: that is a
      // fact of the selection record, not of the base (issue #1165 D5).
      ...(storedIssueBase !== undefined
        ? { issueBase: persistedIssueBase(storedIssueBase as IssueBaseRecord) }
        : {}),
      ...(retainedTestFiles.length > 0
        ? { retainedTestFiles: retainedTestFiles.map((entry) => ({ file: entry.file, addedBy: entry.addedBy })) }
        : {}),
      ...(storedRetainedOverflow === true ? { retainedTestFilesOverflowed: true as const } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Store operations
// ---------------------------------------------------------------------------

/**
 * The store surface these operations need — the shipped port methods only
 * (#1094 §9: no new store method). Every write is an ordinary CAS on
 * `AiTask.revision` through `completePhaseWithEffects`, which lands the context
 * patch, the audit event and any accompanying outbox effect in one transaction
 * on both backends.
 */
export type StagedVerificationStore = Pick<TaskStore, "getTask" | "completePhaseWithEffects">;

export type StagedVerificationStateRead =
  | { status: "ok"; task: AiTask; state: StagedVerificationState | undefined }
  | { status: "not_found" }
  | { status: "malformed"; detail: string };

/**
 * Read one task's stage state; fails closed on malformed state.
 *
 * This is the "evidence survives a restart" path: the bundles, the ledger and
 * the ordinals are task context, so a new process reads exactly what the last
 * one committed, with no in-memory state and no reconciliation step.
 */
export async function readStagedVerificationState(
  store: Pick<TaskStore, "getTask">,
  key: TaskKey,
): Promise<StagedVerificationStateRead> {
  const task = await store.getTask(key);
  if (!task) return { status: "not_found" };
  const validation = validateStagedVerificationState(
    task.context?.[STAGED_VERIFICATION_CONTEXT_KEY],
  );
  if (!validation.valid) return { status: "malformed", detail: validation.detail };
  return { status: "ok", task, state: validation.state };
}

export type StagedVerificationRefusalReason =
  | "not_found"
  | "invalid_input"
  | "malformed_state"
  | "task_terminal"
  /**
   * The allocation names a `taskAttempt` its own (lane, stage) has already
   * moved past. Its ordinals are retired and cannot be extended (#1096 §7.1
   * rule 2).
   */
  | "retired_task_attempt"
  /** No allocation is open for the bundle's stage run (#1096 §7.1 rule 3). */
  | "no_active_stage_run"
  /** A later allocation superseded this run; it is interrupted and credits nothing. */
  | "stage_run_interrupted"
  | "store_rejected";

interface StagedVerificationStale {
  status: "stale";
  observedTaskRevision: number;
  currentTaskRevision?: number;
  current?: AiTask;
}

const TERMINAL_TASK_STATUSES = new Set(["done", "failed", "cancelled"]);

function terminalRefusal(
  task: AiTask,
): { reason: StagedVerificationRefusalReason; detail: string } | undefined {
  if (!TERMINAL_TASK_STATUSES.has(task.status)) return undefined;
  return {
    reason: "task_terminal",
    detail: `task is ${task.status}: a terminal task runs no stage and records no evidence`,
  };
}

function mapCommitFailure(
  committed: Extract<StoreResult<AiTask>, { ok: false }>,
  observedTaskRevision: number,
):
  | { status: "maintenance_locked" }
  | { status: "refused"; reason: StagedVerificationRefusalReason; detail: string }
  | StagedVerificationStale {
  if (committed.code === "maintenance_locked") return { status: "maintenance_locked" };
  if (committed.code === "not_found") {
    return { status: "refused", reason: "not_found", detail: "task disappeared before the write" };
  }
  if (committed.code === "conflict") {
    return {
      status: "stale",
      observedTaskRevision,
      ...(committed.current ? { currentTaskRevision: committed.current.revision, current: committed.current } : {}),
    };
  }
  return {
    status: "refused",
    reason: "store_rejected",
    detail: `store refused the write (${committed.code})`,
  };
}

function emptyState(): StagedVerificationState {
  return {
    version: STAGED_VERIFICATION_LEGACY_STATE_VERSION,
    ordinals: [],
    runs: [],
    loopBundles: [],
    finalBundles: [],
  };
}

/**
 * Keep every live cursor, then the newest of the rest.
 *
 * Task attempts advance per phase, so an attempt number is chronological only
 * *within* one lane: a review lane on attempt 65 says nothing about an
 * implementation lane still on attempt 1. Ranking every lane by `taskAttempt`
 * would therefore evict a freshly allocated cursor in a quiet lane, and the next
 * allocation there would re-mint an ordinal the ledger already holds — a
 * duplicate stage run, which the read then refuses outright.
 *
 * So the eviction rule is per lane and stage: only the highest attempt of each
 * (lane, stage) can still allocate, and that cursor is never dropped. Anything
 * below it belongs to an attempt its own lane has already left behind, and
 * {@link allocateStageRun} refuses such an attempt outright — an evicted cursor
 * is therefore never mistaken for a tuple that has yet to allocate, which is
 * what makes evicting it safe. The live set is bounded by |lanes| x |stages| —
 * far under the budget — so it cannot crowd the window out.
 */
function pruneOrdinalCursors(cursors: readonly StageOrdinalCursor[]): readonly StageOrdinalCursor[] {
  if (cursors.length <= MAX_STAGE_ORDINAL_CURSORS) return cursors;
  const live = new Map<string, number>();
  cursors.forEach((cursor, index) => {
    const key = `${cursor.lane}/${cursor.stage}`;
    const held = live.get(key);
    // `<=` so the just-appended cursor wins a tie: it is the one this write
    // allocated against.
    if (held === undefined || cursors[held].taskAttempt <= cursor.taskAttempt) {
      live.set(key, index);
    }
  });
  const keep = new Set<number>(live.values());
  const retired = cursors
    .map((cursor, index) => ({ cursor, index }))
    .filter((entry) => !keep.has(entry.index))
    .sort((a, b) => b.cursor.taskAttempt - a.cursor.taskAttempt || b.index - a.index);
  for (const entry of retired) {
    if (keep.size >= MAX_STAGE_ORDINAL_CURSORS) break;
    keep.add(entry.index);
  }
  // Filtering by index keeps the cursors in append order whichever survive.
  return cursors.filter((_, index) => keep.has(index));
}

/**
 * The highest `taskAttempt` this (lane, stage) has ever allocated under, as far
 * as the surviving cursors record it.
 *
 * {@link pruneOrdinalCursors} never evicts a (lane, stage)'s highest cursor, so
 * this is exact for every state this module writes: an attempt at or above it
 * is the live one, and every attempt below it is retired.
 */
function highestAllocatedAttempt(
  state: StagedVerificationState,
  lane: VerificationLane,
  stage: StageId,
): number | undefined {
  let highest: number | undefined;
  for (const cursor of state.ordinals) {
    if (cursor.lane !== lane || cursor.stage !== stage) continue;
    if (highest === undefined || cursor.taskAttempt > highest) highest = cursor.taskAttempt;
  }
  return highest;
}

/**
 * The highest ordinal this exact tuple is still known to have minted, from the
 * durable traces the state carries: its ledger entries and its retained
 * bundles. `-1` when it has none, so a caller adds 1 and lands on #1094 §2's
 * first ordinal.
 *
 * Belt to the cursor's braces. It is never the deciding value for a state this
 * module wrote — the cursor is always at least as high — but it means a reused
 * key cannot be minted even against a state some other writer left short a
 * cursor, and a duplicate key is the one corruption that costs the operator the
 * whole read.
 */
function mintedOrdinalFloor(
  state: StagedVerificationState,
  taskAttempt: number,
  lane: VerificationLane,
  stage: StageId,
): number {
  let highest = -1;
  const ids: readonly StageRunId[] = [
    ...state.runs.map((entry) => entry.stageRunId),
    ...state.loopBundles.map((bundle) => bundle.stageRunId),
    ...state.finalBundles.map((bundle) => bundle.stageRunId),
  ];
  for (const id of ids) {
    if (id.taskAttempt !== taskAttempt || id.lane !== lane || id.stage !== stage) continue;
    if (id.stageOrdinal > highest) highest = id.stageOrdinal;
  }
  return highest;
}

/**
 * Keep the newest ledger entries, never drop an allocation in flight, and
 * never drop the entry of a bundle retention still holds.
 *
 * That last clause is what keeps §7.1 rule 5 true for as long as the evidence
 * itself lasts: replay recognition reads the ledger, so evicting the entry of a
 * still-retained bundle would turn a replayed completion of a committed run
 * into an apparent failure once enough unrelated runs had gone by. The pinned
 * set is bounded by retention itself — one loop entry per lane plus at most
 * three final ones — so it cannot crowd the window out, and retention is never
 * shortened to make room for it (#1094 §6.3 R5).
 */
function pruneRunLedger(
  runs: readonly StageRunLedgerEntry[],
  retained: readonly StageRunResult[],
): readonly StageRunLedgerEntry[] {
  if (runs.length <= MAX_STAGE_RUN_LEDGER_ENTRIES) return runs;
  const pinned = new Set(retained.map((bundle) => stageRunKey(bundle.stageRunId)));
  const allocated = runs.find((entry) => entry.state === "allocated");
  if (allocated) pinned.add(stageRunKey(allocated.stageRunId));
  const keep = new Set<number>();
  runs.forEach((entry, index) => {
    if (pinned.has(stageRunKey(entry.stageRunId))) keep.add(index);
  });
  // Then fill the remaining budget with the newest entries. Walking the
  // indexes keeps the ledger in append order whichever entries survive.
  for (
    let index = runs.length - 1;
    index >= 0 && keep.size < MAX_STAGE_RUN_LEDGER_ENTRIES;
    index -= 1
  ) {
    keep.add(index);
  }
  return runs.filter((_, index) => keep.has(index));
}

export interface AllocateStageRunInput {
  store: StagedVerificationStore;
  key: TaskKey;
  /**
   * The `AiTask.revision` the caller read the task at. The CAS guard: a task
   * that moved since — a competing transition, another allocation — refuses
   * this write with nothing allocated.
   */
  observedTaskRevision: number;
  /**
   * The caller's idempotency key for this allocation. A lost response that is
   * retried with the same key returns the allocation already made rather than
   * burning a second ordinal (#1096 §7.1 rule 6's "retries are new runs" is
   * about a re-RUN, not about a repeated call for the same one).
   */
  requestKey: string;
  taskAttempt: number;
  lane: VerificationLane;
  stage: StageId;
  /** #1096 §4.3 rule 1: resolved before this call, all seven components. */
  identity: StageEvidenceIdentity;
  /** Committed in the same transaction, for a caller that has one. Normally empty. */
  effects?: OutboxEffect[];
  /**
   * Extra task-context keys committed with the allocation (issue #1106). The
   * review lane's final stage persists the approval it is verifying here, so a
   * run that dies mid-stage leaves a continuation the next claim can resume
   * without re-running the review agent. Never the `stagedVerification` key:
   * this write's own state always wins.
   */
  contextPatch?: Record<string, unknown>;
  runId?: string;
  now?: string;
}

export type AllocateStageRunOutcome =
  | { status: "allocated"; task: AiTask; entry: StageRunLedgerEntry; state: StagedVerificationState; event: TaskEvent }
  | { status: "replay"; entry: StageRunLedgerEntry }
  | { status: "refused"; reason: StagedVerificationRefusalReason; detail: string }
  | StagedVerificationStale
  | { status: "maintenance_locked" };

/**
 * Allocate the next stage run ordinal and write its launch identity — #1096
 * §7.1 rule 2's "before launch", and the first of the two observable states.
 *
 * An allocation still open from an earlier run is marked `interrupted` in the
 * same write: it produced no bundle, it is never resumed, and recording it as
 * interrupted is what turns a crash into a detectable signature instead of an
 * ordinal nobody can explain (§7.1 rules 3–4).
 *
 * An attempt its own (lane, stage) has already moved past is refused
 * `retired_task_attempt` rather than allocated: ordinals advance forward only,
 * and a retired attempt's cursor may no longer be on the task to advance from.
 */
export async function allocateStageRun(
  input: AllocateStageRunInput,
): Promise<AllocateStageRunOutcome> {
  const now = input.now ?? new Date().toISOString();

  if (!isBoundedText(input.requestKey)) {
    return { status: "refused", reason: "invalid_input", detail: "requestKey: not bounded text" };
  }
  if (!isNonNegativeInteger(input.taskAttempt)) {
    return { status: "refused", reason: "invalid_input", detail: "taskAttempt: not a non-negative integer" };
  }
  if (!(VERIFICATION_LANES as readonly unknown[]).includes(input.lane)) {
    return { status: "refused", reason: "invalid_input", detail: "lane: not one of the closed lane set" };
  }
  if (!(STAGE_IDS as readonly unknown[]).includes(input.stage)) {
    return { status: "refused", reason: "invalid_input", detail: "stage: not one of the closed stage set" };
  }
  const identityIssue = identityProblem(input.identity, "identity");
  if (identityIssue) {
    return { status: "refused", reason: "invalid_input", detail: identityIssue };
  }

  const task = await input.store.getTask(input.key);
  if (!task) {
    return {
      status: "refused",
      reason: "not_found",
      detail: `no task for ${input.key.sessionId}#${input.key.issueNumber}`,
    };
  }

  const stored = validateStagedVerificationState(task.context?.[STAGED_VERIFICATION_CONTEXT_KEY]);
  if (!stored.valid) {
    return { status: "refused", reason: "malformed_state", detail: stored.detail };
  }
  const state = stored.state ?? emptyState();

  const replayed = state.runs.find((entry) => entry.requestKey === input.requestKey);
  if (replayed) return { status: "replay", entry: replayed };

  const terminal = terminalRefusal(task);
  if (terminal) return { status: "refused", ...terminal };

  // #1096 §7.1 rule 2: an ordinal is never reused. A cursor's absence is only
  // evidence of "never allocated" for an attempt this (lane, stage) has not
  // moved past — below its high-water attempt the absence may equally be
  // {@link pruneOrdinalCursors} having evicted a retired cursor, and treating
  // that as a fresh tuple would mint an ordinal the ledger already holds. So a
  // retired attempt is refused rather than guessed at, which is also what makes
  // the eviction rule sound: a cursor below the high-water mark can never
  // allocate again.
  const highWater = highestAllocatedAttempt(state, input.lane, input.stage);
  if (highWater !== undefined && input.taskAttempt < highWater) {
    return {
      status: "refused",
      reason: "retired_task_attempt",
      detail:
        `taskAttempt ${input.taskAttempt} is behind ${input.lane}/${input.stage}'s `
        + `attempt ${highWater}: a retired attempt allocates no further ordinal (#1096 §7.1 rule 2)`,
    };
  }

  const cursorKey = `${input.taskAttempt}/${input.lane}/${input.stage}`;
  const cursor = state.ordinals.find(
    (entry) => `${entry.taskAttempt}/${entry.lane}/${entry.stage}` === cursorKey,
  );
  // #1094 §2: ordinals start at 0 per (attempt, lane, stage). A cursor holds the
  // ordinal last handed out, so its absence — not a zero — is what marks a lane
  // that has never allocated. The durable traces of this tuple are a floor under
  // it: with the guard above they never exceed the cursor, and reading them
  // costs one pass to guarantee the write cannot mint a key the state already
  // carries whatever wrote that state.
  const lastOrdinal = Math.max(
    cursor === undefined ? -1 : cursor.lastOrdinal,
    mintedOrdinalFloor(state, input.taskAttempt, input.lane, input.stage),
  );
  const stageOrdinal = lastOrdinal + 1;
  const stageRunId: StageRunId = {
    taskAttempt: input.taskAttempt,
    lane: input.lane,
    stage: input.stage,
    stageOrdinal,
  };
  const entry: StageRunLedgerEntry = {
    stageRunId,
    requestKey: input.requestKey,
    identity: input.identity,
    allocatedAt: now,
    state: "allocated",
  };

  // §7.1 rules 3–4: whatever was in flight is over. It never produced a bundle,
  // so it credits nothing; recording it as interrupted is the difference
  // between a detectable crash and an ordinal with no story.
  const runs = state.runs.map((existing) =>
    existing.state === "allocated"
      ? { ...existing, state: "interrupted" as const, interruptedAt: now }
      : existing,
  );
  // §7.3 rule 5: a superseded final run is an `interrupted` termination, and it
  // extends the recovery streak exactly as a recorded one would.
  const supersededFinal = state.runs.find(
    (existing) => existing.state === "allocated" && isReviewFinalRun(existing.stageRunId),
  );
  const allocatedState: StagedVerificationState = {
    ...state,
    ...(supersededFinal ? nextFinalRecoveryStreak(state, false) : {}),
    ordinals: pruneOrdinalCursors([
      ...state.ordinals.filter(
        (existing) => `${existing.taskAttempt}/${existing.lane}/${existing.stage}` !== cursorKey,
      ),
      { taskAttempt: input.taskAttempt, lane: input.lane, stage: input.stage, lastOrdinal: stageOrdinal },
    ]),
    runs: pruneRunLedger([...runs, entry], [...state.loopBundles, ...state.finalBundles]),
  };
  const nextState: StagedVerificationState = {
    ...allocatedState,
    version: stagedVerificationStateVersion(allocatedState),
  };

  const superseded = state.runs.find((existing) => existing.state === "allocated");
  const event: TaskEvent = {
    task: input.key,
    type: STAGE_RUN_ALLOCATED_EVENT,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    // #1096 §8 rule 10: component NAMES and STATES, never their values, and
    // never a path, a command byte or an environment value.
    data: {
      ...stageRunId,
      stageRunKey: stageRunKey(stageRunId),
      identityStates: identityStates(input.identity),
      ...(superseded ? { supersededStageRunKey: stageRunKey(superseded.stageRunId) } : {}),
    },
    createdAt: now,
  };

  const committed = await input.store.completePhaseWithEffects(
    {
      key: input.key,
      expected: { status: task.status, revision: input.observedTaskRevision },
      patch: {
        context: { ...(input.contextPatch ?? {}), [STAGED_VERIFICATION_CONTEXT_KEY]: nextState },
        now,
      },
      event,
    },
    input.effects ?? [],
  );
  if (committed.ok) {
    return { status: "allocated", task: committed.value, entry, state: nextState, event };
  }
  return mapCommitFailure(committed, input.observedTaskRevision);
}

function identityStates(identity: StageEvidenceIdentity): Record<string, string> {
  const states: Record<string, string> = {};
  for (const name of STAGE_IDENTITY_COMPONENTS) {
    states[name] = identity[name].state;
  }
  return states;
}

export interface RecordStageRunInput {
  store: StagedVerificationStore;
  key: TaskKey;
  /** The `AiTask.revision` the caller observed. Same CAS discipline as above. */
  observedTaskRevision: number;
  /** The bundle, minus the identity and timestamps the write stamps itself. */
  bundle: StageRunResultInput;
  /**
   * Outbox effects belonging to THIS completion — #1094 §8's one-transaction
   * rule, kept as a seam so the row-7 grant can commit with the bundle that
   * earned it rather than beside it. Empty in every shipped caller today.
   */
  effects?: OutboxEffect[];
  /**
   * Set when the `effects` above carry #1094 §7 row 7's stack-ready grant for
   * THIS bundle — the one publication that makes the bundle an R1 bundle.
   *
   * Declared rather than sniffed out of `effects`: the grant is a label enqueue
   * whose name comes from session configuration, which this module does not
   * read, and a retention rule that guessed at effect payloads would silently
   * stop pinning the moment a caller renamed the label. The caller that decides
   * row 7 states what it published, and the write refuses a declaration the
   * bundle could not have earned.
   *
   * A recording that leaves this unset publishes no grant, so it never displaces
   * the pinned bundle — that is the whole R1 floor.
   */
  grantsStackReady?: boolean;
  runId?: string;
  now?: string;
}

export type RecordStageRunOutcome =
  | {
      status: "recorded";
      task: AiTask;
      bundle: StageRunResult;
      state: StagedVerificationState;
      event: TaskEvent;
      /**
       * The exact task-context patch this write committed. Usually the staged
       * block alone; a D5 base advance adds the eviction of the pending review
       * approval beside it. A caller with no durable store — the context-only
       * shim — must carry THIS, not just `state`, or the completion it builds
       * would re-apply only half of an advance.
       */
      contextPatch: Record<string, unknown>;
    }
  | {
      status: "replay";
      /**
       * Absent only when the bundle is what recognized the replay: the ledger
       * is bounded and a persisted state can express a retained bundle whose
       * entry is no longer there. A caller that needs the allocation's own
       * fields reads the bundle's `startedAt` and `identity`, which carry them.
       */
      entry?: StageRunLedgerEntry;
      bundle?: StageRunResult;
    }
  | { status: "refused"; reason: StagedVerificationRefusalReason; detail: string }
  | StagedVerificationStale
  | { status: "maintenance_locked" };

/**
 * Commit one stage run's evidence bundle — the second and last observable
 * state (#1096 §7.1 rule 3).
 *
 * Four properties are the reason this is one function and not a patch:
 *
 * 1. **Idempotent on `stageRunId`.** A replay of a run whose bundle is already
 *    committed re-records nothing, re-enqueues nothing, and returns what is
 *    already there — #1096 §7.1 rule 5, with no new dedupe surface.
 * 2. **A bundle needs its allocation.** Only the run the ledger currently holds
 *    open may record, so a crashed run that a later allocation superseded can
 *    never land its evidence late and can never complete a stage that was
 *    interrupted.
 * 3. **The identity is stamped, not supplied.** It is whatever was resolved
 *    before launch, so no caller can record a bundle under an identity other
 *    than the one its run started with (#1096 §4.3 rule 1).
 * 4. **Retention is the write.** R1, R3 and R4 are applied here — one loop
 *    bundle per lane, the latest final bundle, and beside it both the
 *    bundle a live grant rests on and the latest complete, passing, full-set
 *    one — so no pruning policy and no later caller has to remember them.
 *    `grantsStackReady` is how a caller says this transaction published the
 *    grant, and it is the only thing that moves the R1 pin.
 *
 * What it does not do is judge. `identityRecheck` is recorded verbatim and
 * does not decide the outcome here: #1096 §4.3 rule 3's end-of-run comparison
 * is the stage model's (S1), and the caller that made it records the outcome it
 * reached. The one exception is a test-file grant (issue #1153, §8 invariant 1),
 * refused unless the re-check is present and matches the launch identity under
 * the single shared {@link matchIdentityComponent}.
 */
export async function recordStageRun(input: RecordStageRunInput): Promise<RecordStageRunOutcome> {
  const now = input.now ?? new Date().toISOString();

  // Checked through an `unknown` alias so a caller reaching this from plain
  // JavaScript — the admin and handler surfaces of later slices — gets the
  // refusal rather than a TypeError on the first field access.
  const rawBundle: unknown = input.bundle;
  if (!isPlainObject(rawBundle)) {
    return { status: "refused", reason: "invalid_input", detail: "bundle: not an object" };
  }
  const stageRunIssue = stageRunIdProblem(input.bundle.stageRunId, "bundle.stageRunId");
  if (stageRunIssue) {
    return { status: "refused", reason: "invalid_input", detail: stageRunIssue };
  }
  // The two containers the copy below walks. Everything else about them is
  // {@link bundleProblem}'s to judge, once there is a bundle to judge.
  const rawSelection: unknown = input.bundle.selection;
  if (!isPlainObject(rawSelection) || !Array.isArray(rawSelection.checkIds)) {
    return {
      status: "refused",
      reason: "invalid_input",
      detail: "bundle.selection: not an object carrying checkIds",
    };
  }
  const rawChecks: unknown = input.bundle.checks;
  if (!Array.isArray(rawChecks)) {
    return { status: "refused", reason: "invalid_input", detail: "bundle.checks: not an array" };
  }
  if (input.bundle.identityRecheck !== undefined) {
    const recheckIssue = identityProblem(input.bundle.identityRecheck, "bundle.identityRecheck");
    if (recheckIssue) return { status: "refused", reason: "invalid_input", detail: recheckIssue };
  }

  const task = await input.store.getTask(input.key);
  if (!task) {
    return {
      status: "refused",
      reason: "not_found",
      detail: `no task for ${input.key.sessionId}#${input.key.issueNumber}`,
    };
  }

  const stored = validateStagedVerificationState(task.context?.[STAGED_VERIFICATION_CONTEXT_KEY]);
  if (!stored.valid) {
    return { status: "refused", reason: "malformed_state", detail: stored.detail };
  }
  const state = stored.state;
  const ledgerEntry = stageRunLedgerEntry(state, input.bundle.stageRunId);
  const committedBundle = stageRunBundle(state, input.bundle.stageRunId);

  // Either durable trace of a committed run is enough to recognize the replay.
  // The bundle is consulted independently of the ledger because the two are
  // bounded independently: a retained bundle whose ledger entry is gone is
  // still a run that completed, and answering `no_active_stage_run` there would
  // report a successful operation as a failure (§7.1 rule 5).
  if (
    ledgerEntry?.state === "recorded"
    || (ledgerEntry === undefined && committedBundle !== undefined)
  ) {
    return {
      status: "replay",
      ...(ledgerEntry !== undefined ? { entry: ledgerEntry } : {}),
      ...(committedBundle !== undefined ? { bundle: committedBundle } : {}),
    };
  }
  if (ledgerEntry?.state === "interrupted") {
    return {
      status: "refused",
      reason: "stage_run_interrupted",
      detail:
        `stage run ${stageRunKey(input.bundle.stageRunId)} was superseded by a later allocation: `
        + "an interrupted run is never resumed and never partially credited (#1096 §7.1 rule 4)",
    };
  }
  if (!ledgerEntry || !state) {
    return {
      status: "refused",
      reason: "no_active_stage_run",
      detail: `no allocation is open for stage run ${stageRunKey(input.bundle.stageRunId)}`,
    };
  }

  const terminal = terminalRefusal(task);
  if (terminal) return { status: "refused", ...terminal };

  const bundle: StageRunResult = {
    ...input.bundle,
    stageRunId: { ...input.bundle.stageRunId },
    selection: { ...input.bundle.selection, checkIds: [...input.bundle.selection.checkIds] },
    checks: input.bundle.checks.map((check) => ({ ...check })),
    identity: ledgerEntry.identity,
    startedAt: ledgerEntry.allocatedAt,
    recordedAt: now,
  };
  const bundleIssue = bundleProblem(bundle, "bundle", "write");
  if (bundleIssue) {
    return { status: "refused", reason: "invalid_input", detail: bundleIssue };
  }

  // §6.2 rule 3, enforced on the WRITE only: every selected check appears,
  // passed and failed alike, so one escalation surfaces one set — a check the
  // run never reached is recorded `not-run` with its cause rather than omitted.
  // A stored bundle that is short a record is still read (it is simply
  // incomplete, and retained for the operator); a caller writing one is
  // producing evidence nobody can interpret, and is refused.
  const recordedIds = new Set(bundle.checks.map((check) => check.checkId));
  const omitted = bundle.selection.checkIds.find((checkId) => !recordedIds.has(checkId));
  if (omitted !== undefined) {
    return {
      status: "refused",
      reason: "invalid_input",
      detail: `bundle.checks: no record for selected check ${omitted} (§6.2 rule 3)`,
    };
  }

  // The bundle's plan identity and head must be the ones the run was allocated
  // under. Recording a bundle whose plan or head disagrees with its own launch
  // identity would produce evidence no comparison could ever interpret.
  const coherence = bundleIdentityCoherence(bundle, ledgerEntry.identity);
  if (coherence) return { status: "refused", reason: "invalid_input", detail: coherence };

  // #1094 §7 rule 1 / invariant 7: only a complete, `passed`, full-set FINAL
  // bundle can carry the grant. Persisting the pointer for anything else would
  // record a grant whose evidence never established it — and would displace the
  // bundle that did.
  if (
    input.grantsStackReady
    && (bundle.stageRunId.stage !== "final" || !isGrantingShapedFinalBundle(bundle))
  ) {
    return {
      status: "refused",
      reason: "invalid_input",
      detail:
        "grantsStackReady: a stack-ready grant needs a complete, passed, full-set final bundle "
        + "(#1094 §7 rule 1; the loop stage never grants)",
    };
  }

  // Issue #1153 (`docs/changed-file-verification-contract.md` §5 rule 1): a
  // bundle that carries a test-file record grants only on a Stage 2 `passed`,
  // and once the task has entered the test-file flow a bundle without one never
  // grants: absence is never success (§8 rule 4).
  if (input.grantsStackReady && bundle.testFiles === undefined && carriesTestFileState(state)) {
    return {
      status: "refused",
      reason: "invalid_input",
      detail: "grantsStackReady: this task uses test-file verification, and a final bundle with no Stage 2 test result never grants",
    };
  }
  if (input.grantsStackReady && bundle.testFiles !== undefined && bundle.testFiles.result !== "passed") {
    return {
      status: "refused",
      reason: "invalid_input",
      detail: `grantsStackReady: a Stage 2 "${bundle.testFiles.result}" result never grants (only "passed" does)`,
    };
  }
  // §8 invariant 1: a test-file result counts only for the identity recorded at
  // launch AND re-checked at the end. Launch and publication identities can
  // agree across a run whose revision or configuration moved and moved back, so
  // a grant without a present, matching end-of-run attestation is refused.
  if (input.grantsStackReady && bundle.testFiles !== undefined) {
    const recheck = bundle.identityRecheck;
    const unmatched = recheck === undefined
      ? "no"
      : STAGE_IDENTITY_COMPONENTS.some(
          (component) => !matchIdentityComponent(ledgerEntry.identity[component], recheck[component]),
        )
        ? "a mismatched"
        : undefined;
    if (unmatched !== undefined) {
      return {
        status: "refused",
        reason: "invalid_input",
        detail: `grantsStackReady: a Stage 2 test-file bundle with ${unmatched} end-of-run identity recheck never grants (§8 invariant 1)`,
      };
    }
  }

  // Issue #1153: the Issue base is written once, by the first Stage 1 selection
  // whose base resolved. It moves again only for a declared, accepted
  // predecessor update (issue #1165, decision D5); a bundle naming another one
  // is refused rather than recorded beside it (§4.1 rule 1).
  const issueBase = nextIssueBase(state.issueBase, bundle);
  if (issueBase.problem !== undefined) {
    return { status: "refused", reason: "invalid_input", detail: issueBase.problem };
  }
  // D5: the diff is taken from a different commit from here on, so every stage
  // result recorded against the old base — and the review approval any of them
  // could have carried into a grant — is unusable. The retained failing files
  // are NOT evidence of a revision: they are the Issue's own obligations, and a
  // re-base leaves them exactly as they were.
  const baseAdvanced = issueBase.advanced === true;
  // §4.3: the retained set rides the same write as the Stage 2 result that
  // decides it, so a retry, a restart or a requeue reads exactly what this
  // recording left.
  const retained = nextRetainedTestFiles(
    { files: state.retainedTestFiles ?? [], overflowed: state.retainedTestFilesOverflowed === true },
    { stage: bundle.stageRunId.stage, stageRunKey: stageRunKey(bundle.stageRunId), record: bundle.testFiles },
  );

  // R1: the pin moves only when THIS transaction publishes the replacement
  // grant. Otherwise whatever the task was already carrying stays pinned —
  // recording alone, however green, replaces no marker — unless the base just
  // advanced, which unmakes the grant along with the evidence under it (D5).
  const grantingStageRunKey = input.grantsStackReady
    ? stageRunKey(bundle.stageRunId)
    : baseAdvanced
      ? undefined
      : state.grantingStageRunKey;

  // §7.3 rule 5: only the review lane's final stage moves the recovery streak.
  // A grant or a code verdict ends it; every other termination extends it.
  const { finalRecoveryStreak: priorStreak, ...stateWithoutStreak } = state;
  const streak = isReviewFinalRun(bundle.stageRunId)
    ? nextFinalRecoveryStreak(
        state,
        input.grantsStackReady === true
          || bundle.outcome === "code-failed"
          || bundle.outcome === "timed-out"
          || bundle.outcome === "unknown",
      )
    : priorStreak !== undefined ? { finalRecoveryStreak: priorStreak } : {};
  // The Issue base and the retained set ride the same write as the bundle that
  // decides them (issue #1153), so a retry, a restart or a requeue reads exactly
  // what this recording left.
  // The pin is stripped here too: it is re-added below only when the computed
  // value is defined, so an advance that drops it (D5) actually removes the key
  // instead of letting the prior one ride through on the spread.
  const {
    issueBase: _priorIssueBase,
    retainedTestFiles: _priorRetained,
    retainedTestFilesOverflowed: _priorRetainedOverflow,
    grantingStageRunKey: _priorGrantingStageRunKey,
    ...stateWithoutCarried
  } = stateWithoutStreak;
  // D5 invalidation. NO prior bundle survives an advance — not even the one a
  // live grant rested on. Keeping the granting bundle would leave the head and
  // identity `evaluateFinalStageReuse` matches on intact whenever the newly
  // accepted predecessor head was already an ancestor of this branch (the Issue
  // branch HEAD does not move, so the old Stage 2 still "binds"), and a fresh
  // approval of the re-based revision would then publish a grant with no Stage 2
  // run after the advance. §4.1 rule 1 requires the opposite: every stage result
  // and review approval recorded against the old base is invalidated, so the next
  // cycle must re-run Stage 1, re-approve and re-run Stage 2 at the new base. The
  // R1 pin is dropped in the same write (above) so it never names an evicted
  // bundle, and `decideStackReadyPublication` — which compares a completion's
  // marker against that pin — withholds until the fresh Stage 2 grants again.
  const priorLoopBundles: readonly StageRunResult[] = baseAdvanced ? [] : state.loopBundles;
  const priorFinalBundles: readonly StageRunResult[] = baseAdvanced ? [] : state.finalBundles;
  const recordedState: StagedVerificationState = {
    ...stateWithoutCarried,
    ...streak,
    ...(issueBase.base !== undefined ? { issueBase: persistedIssueBase(issueBase.base) } : {}),
    ...(retained.files.length > 0 ? { retainedTestFiles: retained.files } : {}),
    ...(retained.overflowed ? { retainedTestFilesOverflowed: true as const } : {}),
    ...(grantingStageRunKey !== undefined ? { grantingStageRunKey } : {}),
    runs: state.runs.map((entry) =>
      stageRunKey(entry.stageRunId) === stageRunKey(bundle.stageRunId)
        ? {
            ...entry,
            state: "recorded" as const,
            recordedAt: now,
            outcome: bundle.outcome,
            complete: bundle.complete,
          }
        : entry,
    ),
    loopBundles:
      bundle.stageRunId.stage === "loop"
        ? retainLoopBundles(priorLoopBundles, bundle)
        : priorLoopBundles,
    finalBundles:
      bundle.stageRunId.stage === "final"
        ? retainFinalBundles(priorFinalBundles, bundle, grantingStageRunKey)
        : priorFinalBundles,
  };
  const nextState: StagedVerificationState = {
    ...recordedState,
    version: stagedVerificationStateVersion(recordedState),
  };

  const event: TaskEvent = {
    task: input.key,
    type: STAGE_RUN_RECORDED_EVENT,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    // Counts, digests, names and states — no output bytes, no log paths, no
    // command bytes and no operator prose (#1094 §10 rule 5, #1096 §8 rule 10).
    data: {
      ...bundle.stageRunId,
      stageRunKey: stageRunKey(bundle.stageRunId),
      outcome: bundle.outcome,
      complete: bundle.complete,
      planDigest: bundle.planDigest,
      ...(bundle.testFiles !== undefined
        ? {
            testFiles: {
              result: bundle.testFiles.result,
              selection: bundle.testFiles.selection.status,
              failedFileCount: bundle.testFiles.outcomeCounts?.failed ?? bundle.testFiles.failedFiles.length,
              retainedTestFileCount: retained.files.length,
              retainedTestFilesAdded: retained.files.length - (state.retainedTestFiles?.length ?? 0),
            },
          }
        : {}),
      selection: {
        full: bundle.selection.full,
        count: bundle.selection.checkIds.length,
        selectionDigest: bundle.selection.selectionDigest,
      },
      verdicts: verdictCounts(bundle.checks),
      identityStates: identityStates(bundle.identity),
      ...(bundle.durationMs !== undefined ? { durationMs: bundle.durationMs } : {}),
    },
    createdAt: now,
  };

  // D5, second half of the invalidation. Evicting the bundles (above) unmakes
  // the stage evidence, but the approval a previous final stage left waiting
  // lives OUTSIDE the staged block, as a top-level continuation bound to the
  // approved head (`FinalStageApprovalContinuation`). A newly accepted
  // predecessor head that was already an ancestor moves no branch head, so that
  // continuation would still bind, and the review lane — which reads it before
  // Stage 1 and matches on the head alone — would skip the reviewer entirely and
  // run Stage 2 under the approval of the pre-advance base. §4.1 rule 1 requires
  // a fresh approval of the re-based revision, so the continuation is dropped in
  // the same transaction that advances the base: one write, or the approval
  // outlives the evidence it was given for.
  const contextPatch: Record<string, unknown> = {
    [STAGED_VERIFICATION_CONTEXT_KEY]: nextState,
    ...(baseAdvanced ? { [FINAL_STAGE_APPROVAL_CONTEXT_KEY]: null } : {}),
  };
  const committed = await input.store.completePhaseWithEffects(
    {
      key: input.key,
      expected: { status: task.status, revision: input.observedTaskRevision },
      patch: { context: contextPatch, now },
      event,
    },
    input.effects ?? [],
  );
  if (committed.ok) {
    return { status: "recorded", task: committed.value, bundle, state: nextState, event, contextPatch };
  }
  return mapCommitFailure(committed, input.observedTaskRevision);
}

function bundleIdentityCoherence(
  bundle: StageRunResult,
  identity: StageEvidenceIdentity,
): string | undefined {
  const planDigest = identity.planDigest;
  if (planDigest.state === "value" && planDigest.value !== bundle.planDigest) {
    return "bundle.planDigest: differs from the planDigest this run was allocated under";
  }
  const testedRevision = identity.testedRevision;
  if (
    testedRevision.state === "value"
    && bundle.headSha !== undefined
    && testedRevision.value !== bundle.headSha
  ) {
    return "bundle.headSha: differs from the testedRevision this run was allocated under";
  }
  // Issue #1153 (§6 rule 5, §8 invariant 1): a test-file run's configuration
  // identity carries its suite binding as `selectionPolicyDigest`, so evidence
  // recorded under one binding can never match a run under another. A component
  // the run could not attest stays `unknown` and is the result's to report.
  const policy = identity.selectionPolicyDigest;
  if (
    bundle.testFiles !== undefined
    && (policy.state === "none"
      || (policy.state === "value" && policy.value !== bundle.testFiles.suiteBindingDigest))
  ) {
    return "bundle.testFiles.suiteBindingDigest: differs from the selectionPolicyDigest this run was allocated under";
  }
  return undefined;
}

function verdictCounts(checks: readonly CheckExecutionRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const verdict of CHECK_VERDICTS) counts[verdict] = 0;
  for (const check of checks) counts[check.verdict] = (counts[check.verdict] ?? 0) + 1;
  return counts;
}

/**
 * R3: the next loop bundle in the same lane supersedes the previous one.
 *
 * Issue #1155 removed the one exception — #1094 §7 row 5's retained pair, where
 * a first `unknown` loop stage was re-run once over the entire required set and
 * both bundles were kept. That full re-run is retired with the selection policy
 * it existed to widen, so there is no pair left to retain.
 */
function retainLoopBundles(
  existing: readonly StageRunResult[],
  next: StageRunResult,
): readonly StageRunResult[] {
  return [
    ...existing.filter((bundle) => bundle.stageRunId.lane !== next.stageRunId.lane),
    next,
  ];
}

/**
 * R1 and R4: keep the new final bundle (R4), the bundle a live grant actually
 * rests on (R1), and the most recent granting-shaped one beside them.
 *
 * Two slots, because "granted" and "could have granted" are different facts:
 *
 * - **The R1 pin** is the bundle whose own recording transaction enqueued the
 *   stack-ready grant, named by `grantingStageRunKey` (#1094 §8 step 5). It is
 *   displaced only by a *later grant*, never by a later run — a full-set
 *   passing run that published nothing replaced no marker, so the earlier
 *   bundle's grant is still live and dropping its evidence would breach R1
 *   before the task reached a terminal state. Nothing an adapter or a pruning
 *   policy does shortens it either (#1094 §6.3 R5).
 * - **The granting-shaped slot** covers the grant this module never saw
 *   published: a caller that records the row-7 bundle without declaring the
 *   grant, and every legacy row. Keeping the most recent §4.3-shaped bundle
 *   there is the conservative reading — it is the only bundle such a grant
 *   could have rested on. A later run that passed only the checks it selected
 *   never takes that slot, since a partial bundle can never have granted at all.
 *
 * Both collapse into the newest bundle when it is itself the pinned or the
 * granting-shaped one, so retention is bounded at three and usually holds one.
 */
function retainFinalBundles(
  existing: readonly StageRunResult[],
  next: StageRunResult,
  grantingStageRunKey: string | undefined,
): readonly StageRunResult[] {
  const nextKey = stageRunKey(next.stageRunId);
  const retained: StageRunResult[] = [];
  const keep = (bundle: StageRunResult | undefined): void => {
    if (!bundle || stageRunKey(bundle.stageRunId) === nextKey) return;
    if (retained.some((held) => sameStageRunId(held.stageRunId, bundle.stageRunId))) return;
    retained.push(bundle);
  };

  if (grantingStageRunKey !== undefined && grantingStageRunKey !== nextKey) {
    keep(existing.find((bundle) => stageRunKey(bundle.stageRunId) === grantingStageRunKey));
  }
  if (!isGrantingShapedFinalBundle(next)) {
    const shaped = existing.filter(isGrantingShapedFinalBundle);
    keep(shaped[shaped.length - 1]);
  }
  return [...retained, next];
}
