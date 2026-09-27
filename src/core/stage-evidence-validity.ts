/**
 * Stage evidence validity: the matching law and the identity components a
 * comparison is made of (issue #1100 —
 * `docs/verification-evidence-validity-contract.md` §4, the invalidation half
 * of `docs/staged-verification-contract.md` §13's S1).
 *
 * One law, stated once and used everywhere (#1096 §4.4):
 *
 * > Two identity components **match** iff both are in state `value` and their
 * > values are equal, **or** both are in state `none`. A component in state
 * > `unknown` matches nothing, including another component in state `unknown`.
 * > Two identities match iff **all seven** components match, and a bundle is
 * > valid for a use iff its identity matches the identity the use expects.
 *
 * Two halves live here, and the split is the point:
 *
 * 1. **Comparison** — {@link compareStageEvidenceIdentity} and the two uses
 *    #1096 §4.6 admits: {@link evaluateFinalStageReuse} (satisfying a final
 *    stage without re-execution, #1094 §4.4) and
 *    {@link evaluateFinalGrantBinding} (the identity re-check inside the
 *    publication transaction, #1094 §8's "head binding at enqueue" generalized
 *    from one component to seven).
 * 2. **Derivation from already-resolved inputs** — the `derive*Component`
 *    functions turn facts a caller has already read into the three-valued
 *    components #1096 §4.5 specifies. They are pure: no process, no file
 *    system, no git, no clock. *Resolving* those facts — running the status,
 *    reading the prepare stamp — is the execution slice's, and no shipped call
 *    site resolves an identity yet.
 *
 * What this module deliberately is not:
 *
 * - **Not a second validity model.** The plan-side components are derived from
 *   the shipped #1037 checkpoint and `reconcileVerificationPlan` classification,
 *   so an operator amendment and an Issue-refresh revision invalidate stage
 *   evidence through the *same* records that already invalidate a plan — this
 *   module adds no competing notion of "the plan changed". Nothing here writes,
 *   repairs or rebases a checkpoint (#1096 §7.2 rule 2).
 * - **Not the operator-attested evidence evaluator.** #1096 §4.6 rule 3: a
 *   `req:<hex>` slot satisfied by a #1040 manual entry is judged by
 *   `evaluateVerificationEvidenceBinding` verbatim, on its own four binding
 *   fields. The stage identity governs a *stage run* and is never folded into
 *   that evaluator, which this module neither calls nor re-implements.
 * - **Not a scanner.** No component is sniffed. Dependencies are covered twice
 *   and inspected never (#1096 §4.5 rule 1): version-controlled manifests are
 *   part of `testedRevision` because they are files in the commit, uncommitted
 *   ones are part of `workingTreeState`, and the *installed* state is covered by
 *   the prepare stamp whose inputs the operator declared. Core reads no
 *   lockfile, knows no package manager, and interprets no path — hashing the
 *   bytes at a path the shipped status already named interprets nothing.
 * - **Not a pin, a selection, a schedule or a grant.** #1096 §4.4 rule 4's
 *   asymmetry — an invalid bundle can still *arm* a pin and can never *release*
 *   one — belongs to the pin slice, which reads {@link admitStageEvidence} for
 *   the "valid for a use" half and never re-derives it.
 *
 * Invalidation deletes nothing (#1096 §4.4 rule 3, §10 invariant 5). Every
 * function here answers "is this admissible for this use?" and none of them
 * removes, edits or rewrites a bundle: an invalid bundle stays readable with the
 * identity that made it invalid on it, which is what makes the refusal auditable
 * afterwards.
 */

import { createHash } from "crypto";

import {
  deriveTestSuiteBindingDigest,
  type Stage1TestSelection,
  type TestSuiteConfigurationInput,
} from "./changed-test-file-selection.js";
import {
  canonicalJsonStringify,
  deriveSessionBaselineDigest,
  type VerificationPlanCheckpoint,
  type VerificationPlanSessionBaselineEntry,
} from "./verification-amendment.js";
import { normalizeCommitSha } from "./verification-evidence.js";
import type { VerificationPlanReconciliation } from "./verification-plan.js";
import {
  MAX_STAGE_TEXT_CHARS,
  STAGE_IDENTITY_COMPONENTS,
  matchIdentityComponent,
  stageRunKey,
  unknownIdentityComponent,
  type IdentityComponent,
  type StageEvidenceIdentity,
  type StageIdentityComponentName,
  type StageRunLedgerEntry,
  type StageRunResult,
  type VerificationLane,
} from "./staged-verification-state.js";

// ---------------------------------------------------------------------------
// Component constructors
// ---------------------------------------------------------------------------

/** A source that was consulted and gave an identity (#1096 §4.1). */
export function valueIdentityComponent(value: string): IdentityComponent {
  return { state: "value", value };
}

/**
 * A source that was consulted and authoritatively declares nothing (#1096
 * §4.1). `none` is a fact about the *configuration*: it is stable across runs
 * and it therefore compares equal to another `none`.
 *
 * It is never reachable from a failure. Every failure to resolve — a refusal, a
 * crash, a timeout, an unreadable artifact, a malformed record — is
 * `unknownIdentityComponent` with the reason recorded (#1096 §4.1 rule 1), and
 * that asymmetry is what keeps an unattestable run from looking exactly like an
 * unattested one.
 */
export function noneIdentityComponent(source: string): IdentityComponent {
  return { state: "none", source: source.slice(0, MAX_STAGE_TEXT_CHARS) };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A lowercase sha256 digest, which is the only shape a stored digest has. */
function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

// ---------------------------------------------------------------------------
// The matching law (#1096 §4.4)
// ---------------------------------------------------------------------------

/**
 * #1096 §4.4's matching law. Defined beside the identity shape in
 * `staged-verification-state.ts`, whose grant guard applies it too; re-exported
 * here so this module stays the law's public home.
 */
export { matchIdentityComponent };

/**
 * Why one component did not match. Closed: a reader displays these and never
 * parses one for control flow (#1096 §4.5 rule 4).
 */
export const STAGE_IDENTITY_MISMATCH_KINDS = [
  /** Both sides attest a value and the values differ. The world moved. */
  "value-changed",
  /** One side attests a value and the other authoritatively declares none. */
  "state-changed",
  /** The use could not establish what it requires. */
  "expected-unknown",
  /** The evidence cannot attest what it ran under — a legacy bundle included. */
  "evidence-unknown",
] as const;

export type StageIdentityMismatchKind = (typeof STAGE_IDENTITY_MISMATCH_KINDS)[number];

export type IdentityComponentState = IdentityComponent["state"];

/**
 * One component's disagreement, in the vocabulary an operator surface shows.
 *
 * The fields are component names, states and digests only — #1096 §8 rule 10's
 * redaction posture. Every `value` in the closed seven-component tuple is a
 * digest, a commit SHA, the fixed `clean` marker or a decimal ordinal, so
 * carrying the two values exposes no path, no dirty-file name, no command byte
 * and no environment value; the `workingTreeState` digest in particular is the
 * only form in which a working tree ever reaches a surface.
 */
export interface StageIdentityMismatch {
  readonly component: StageIdentityComponentName;
  readonly kind: StageIdentityMismatchKind;
  readonly expectedState: IdentityComponentState;
  readonly evidenceState: IdentityComponentState;
  readonly expectedValue?: string;
  readonly evidenceValue?: string;
  /** The bounded, operator-facing reason an `unknown` carries. Never parsed. */
  readonly expectedReason?: string;
  /** The bounded, operator-facing reason an `unknown` carries. Never parsed. */
  readonly evidenceReason?: string;
}

export type StageIdentityComparison =
  | { readonly matches: true }
  | { readonly matches: false; readonly mismatches: readonly StageIdentityMismatch[] };

function mismatchKind(
  expected: IdentityComponent,
  evidence: IdentityComponent,
): StageIdentityMismatchKind {
  // The evidence side is reported first when both are unknown: "this bundle
  // cannot attest what it ran under" is the fact that decides the use, and the
  // expected side's reason travels on the same record anyway.
  if (evidence.state === "unknown") return "evidence-unknown";
  if (expected.state === "unknown") return "expected-unknown";
  if (expected.state !== evidence.state) return "state-changed";
  return "value-changed";
}

function describeMismatch(
  component: StageIdentityComponentName,
  expected: IdentityComponent,
  evidence: IdentityComponent,
): StageIdentityMismatch {
  return {
    component,
    kind: mismatchKind(expected, evidence),
    expectedState: expected.state,
    evidenceState: evidence.state,
    ...(expected.state === "value" ? { expectedValue: expected.value } : {}),
    ...(evidence.state === "value" ? { evidenceValue: evidence.value } : {}),
    ...(expected.state === "unknown" ? { expectedReason: expected.reason } : {}),
    ...(evidence.state === "unknown" ? { evidenceReason: evidence.reason } : {}),
  };
}

/**
 * Compare two identities under #1096 §4.4, component by component, in
 * `STAGE_IDENTITY_COMPONENTS` order.
 *
 * All seven are always compared. There is no partial validity, no component
 * weighting and no subset comparison (#1096 §4.4 rule 1): skipping
 * `selectionPolicyDigest` for a stage whose suite binding happens not to matter
 * would be sound in isolation and would be one more special case for a later
 * change to break. A component absent from either identity is treated as
 * `unknown`, which is the conservative reading of a record that does not say
 * (#1096 §4.4 rule 5).
 */
export function compareStageEvidenceIdentity(
  expected: StageEvidenceIdentity,
  evidence: StageEvidenceIdentity,
): StageIdentityComparison {
  const mismatches: StageIdentityMismatch[] = [];
  for (const component of STAGE_IDENTITY_COMPONENTS) {
    const expectedComponent = componentOrUnknown(expected, component, "expected-component-absent");
    const evidenceComponent = componentOrUnknown(evidence, component, "evidence-component-absent");
    if (matchIdentityComponent(expectedComponent, evidenceComponent)) continue;
    mismatches.push(describeMismatch(component, expectedComponent, evidenceComponent));
  }
  return mismatches.length === 0 ? { matches: true } : { matches: false, mismatches };
}

function componentOrUnknown(
  identity: StageEvidenceIdentity | undefined,
  component: StageIdentityComponentName,
  reason: string,
): IdentityComponent {
  const value = identity?.[component];
  if (!value || typeof value !== "object" || typeof value.state !== "string") {
    return unknownIdentityComponent(reason);
  }
  return value;
}

/** The boolean form of {@link compareStageEvidenceIdentity}. */
export function stageEvidenceIdentityMatches(
  expected: StageEvidenceIdentity,
  evidence: StageEvidenceIdentity,
): boolean {
  return compareStageEvidenceIdentity(expected, evidence).matches;
}

// ---------------------------------------------------------------------------
// The two uses (#1096 §4.6)
// ---------------------------------------------------------------------------

/**
 * Why a bundle is not admissible for a use. Closed, recorded and displayed;
 * never parsed for control flow, and never a verification failure — a refusal
 * here means the runner does the work again, not that the change is broken.
 */
export const STAGE_EVIDENCE_REFUSALS = [
  /** #1094 §4.4: a `loop` bundle never satisfies a final stage, however full. */
  "stage-not-final",
  "different-task-attempt",
  /** #918 §12.4's rejected cross-lane reuse, restated as a refusal. */
  "different-lane",
  "not-complete",
  "outcome-not-passed",
  /** #1094 §6.2: a final stage's selection is total, so a narrowed one is not it. */
  "selection-not-full",
  "plan-digest-mismatch",
  "head-mismatch",
  /** The bundle or the use names no head, so "same head" cannot be established. */
  "head-unattested",
  /** The run's ledger entry says the run never reached the recorded state. */
  "run-interrupted",
  /** #1096 §4.4: at least one of the seven components did not match. */
  "identity-mismatch",
  /** #1096 §4.3 rule 3: the end-of-run re-check saw the world move mid-run. */
  "identity-recheck-mismatch",
  /**
   * Issue #1153 (§8 invariant 1): a test-file bundle recorded no end-of-run
   * identity attestation, so nothing shows the run stayed on one identity.
   */
  "identity-recheck-missing",
] as const;

export type StageEvidenceRefusalReason = (typeof STAGE_EVIDENCE_REFUSALS)[number];

export interface StageEvidenceRefusal {
  readonly reason: StageEvidenceRefusalReason;
  /** Set for `identity-mismatch` and `identity-recheck-mismatch`. */
  readonly mismatches?: readonly StageIdentityMismatch[];
}

/**
 * The two uses #1096 §4.6 admits, and the only two. Retention, display and
 * audit are explicitly *not* uses: identity restricts what evidence may buy,
 * never what is kept (#1096 §4.6 rule 4).
 */
export type StageEvidenceUse =
  /** #1094 §4.4: satisfy a final stage without launching anything. */
  | "final-reuse"
  /** #1094 §7 row 7 / §8 step 5: publish the stack-ready grant. */
  | "grant";

/** What the use expects the world to be. Resolved by the caller, never here. */
export interface StageEvidenceExpectation {
  readonly taskAttempt: number;
  readonly lane: VerificationLane;
  /** The currently resolved effective plan's #1037 §5.4 digest. */
  readonly planDigest: string;
  /** The head being published, or the head a final stage would run at. */
  readonly headSha?: string;
  /** The identity resolved for the run that would otherwise launch. */
  readonly identity: StageEvidenceIdentity;
}

export interface StageEvidenceAdmissionInput {
  readonly use: StageEvidenceUse;
  readonly bundle: StageRunResult;
  readonly expectation: StageEvidenceExpectation;
  /**
   * The run ledger, when the caller holds it. An entry that exists and is not
   * `recorded` refuses the bundle; an *absent* entry does not, because the
   * ledger is bounded and an old bundle's entry can legitimately have been
   * evicted while the bundle itself is retained.
   */
  readonly ledger?: readonly StageRunLedgerEntry[];
}

export type StageEvidenceAdmission =
  /** `use` travels on the answer so an audit records which question was asked. */
  | { readonly admitted: true; readonly use: StageEvidenceUse; readonly bundle: StageRunResult }
  | {
      readonly admitted: false;
      readonly use: StageEvidenceUse;
      readonly refusals: readonly StageEvidenceRefusal[];
    };

/**
 * Is this bundle admissible for this use?
 *
 * #1094 §4.4's shipped conditions are kept verbatim and are *not* weakened by
 * being joined to the identity tuple (#1096 §4.6 rule 1): same lane, same task
 * attempt, a `final` bundle, complete, `passed`, the same `planDigest` and the
 * same head. The tuple subsumes the last two and is compared as well, because a
 * world can move in five more ways than a head and a plan digest can show.
 *
 * Both uses run the same conditions on purpose. The grant is an effect *of* the
 * bundle (#1094 §8), so a bundle that could not have satisfied the final stage
 * cannot grant either, and one predicate for both is what keeps the two from
 * drifting apart.
 *
 * Every refusal the bundle earns is reported, not just the first: an operator
 * looking at a re-queued final stage wants the whole reason.
 */
export function admitStageEvidence(input: StageEvidenceAdmissionInput): StageEvidenceAdmission {
  const { bundle, expectation } = input;
  const refusals: StageEvidenceRefusal[] = [];
  const refuse = (reason: StageEvidenceRefusalReason, mismatches?: readonly StageIdentityMismatch[]) => {
    refusals.push(mismatches ? { reason, mismatches } : { reason });
  };

  if (bundle.stageRunId.stage !== "final") refuse("stage-not-final");
  if (bundle.stageRunId.taskAttempt !== expectation.taskAttempt) refuse("different-task-attempt");
  if (bundle.stageRunId.lane !== expectation.lane) refuse("different-lane");
  if (!bundle.complete) refuse("not-complete");
  if (bundle.outcome !== "passed") refuse("outcome-not-passed");
  if (!bundle.selection.full) refuse("selection-not-full");
  if (bundle.planDigest !== expectation.planDigest) refuse("plan-digest-mismatch");

  const expectedHead = normalizeCommitSha(expectation.headSha);
  const bundleHead = normalizeCommitSha(bundle.headSha);
  if (!expectedHead || !bundleHead) {
    refuse("head-unattested");
  } else if (expectedHead !== bundleHead) {
    refuse("head-mismatch");
  }

  const entry = input.ledger?.find(
    (candidate) => stageRunKey(candidate.stageRunId) === stageRunKey(bundle.stageRunId),
  );
  if (entry && entry.state !== "recorded") refuse("run-interrupted");

  // #1096 §4.3 rule 3: a run whose end-of-run re-check disagreed with its own
  // launch identity observed the world move mid-run. The execution slice records
  // that run `unknown`, and this check does not depend on its having done so:
  // the bundle carries both identities, so the disagreement is visible here on
  // the evidence alone. A test-file bundle must carry the re-check (issue #1153,
  // §8 invariant 1): launch and publication identities can agree across a run
  // whose revision or configuration moved and moved back, and only the end-of-run
  // attestation sees that.
  if (bundle.identityRecheck) {
    const recheck = compareStageEvidenceIdentity(bundle.identity, bundle.identityRecheck);
    if (!recheck.matches) refuse("identity-recheck-mismatch", recheck.mismatches);
  } else if (bundle.testFiles !== undefined) {
    refuse("identity-recheck-missing");
  }

  const comparison = compareStageEvidenceIdentity(expectation.identity, bundle.identity);
  if (!comparison.matches) refuse("identity-mismatch", comparison.mismatches);

  return refusals.length === 0
    ? { admitted: true, use: input.use, bundle }
    : { admitted: false, use: input.use, refusals };
}

/** One candidate's verdict, so a refusal names the bundle it refused. */
export interface StageEvidenceCandidateRefusal {
  readonly stageRunKey: string;
  readonly refusals: readonly StageEvidenceRefusal[];
}

export interface FinalStageReuseInput {
  /** The retained final bundles, newest first or in any order. */
  readonly bundles: readonly StageRunResult[];
  readonly expectation: StageEvidenceExpectation;
  readonly ledger?: readonly StageRunLedgerEntry[];
}

export type FinalStageReuseDecision =
  | { readonly reusable: true; readonly bundle: StageRunResult }
  | { readonly reusable: false; readonly candidates: readonly StageEvidenceCandidateRefusal[] };

/**
 * #1094 §4.4 with #1096 §4.6 rule 1's identity precondition: may a final stage
 * be satisfied without launching anything?
 *
 * "Produced after the review approval this publication rests on" is not a
 * separate test here and does not need to be: #1094 §4.4 derives it from the
 * same-task-attempt and same-head conditions together with §4.1 rule 2, since a
 * final stage is only ever launched after the review agent returned `success` at
 * that head.
 */
export function evaluateFinalStageReuse(input: FinalStageReuseInput): FinalStageReuseDecision {
  const candidates: StageEvidenceCandidateRefusal[] = [];
  for (const bundle of input.bundles) {
    const admission = admitStageEvidence({
      use: "final-reuse",
      bundle,
      expectation: input.expectation,
      ...(input.ledger ? { ledger: input.ledger } : {}),
    });
    if (admission.admitted) return { reusable: true, bundle };
    candidates.push({ stageRunKey: stageRunKey(bundle.stageRunId), refusals: admission.refusals });
  }
  return { reusable: false, candidates };
}

export interface FinalGrantBindingInput {
  /** The final bundle the grant would be an effect of. */
  readonly bundle: StageRunResult;
  /** Re-resolved inside the publication transaction, never carried from launch. */
  readonly expectation: StageEvidenceExpectation;
  readonly ledger?: readonly StageRunLedgerEntry[];
}

export type FinalGrantBinding =
  | { readonly granted: true; readonly bundle: StageRunResult }
  | {
      readonly granted: false;
      /**
       * #1094 §8: a grant that does not bind is not a failure — the final stage
       * is re-queued and runs again at the head that moved under it.
       */
      readonly requeueFinalStage: true;
      readonly refusals: readonly StageEvidenceRefusal[];
    };

/**
 * #1096 §4.6 rule 2: the publication transaction re-resolves the identity and
 * compares it to the bundle's, so #1094 §8's "head binding at enqueue" becomes
 * an *identity* binding at enqueue. If anything moved between the final stage
 * and the enqueue, the grant is not published and the final stage is re-queued —
 * exactly what #1094 already prescribes for a moved head, seeing six more ways
 * for the world to have moved.
 *
 * There is no override (#1096 §4.4 rule 2). No operator flag, session value,
 * recovery act or `--force` publishes a grant behind a mismatched bundle; an
 * operator who wants a different obligation amends the plan, and one who wants a
 * fresh answer re-runs the stage.
 */
export function evaluateFinalGrantBinding(input: FinalGrantBindingInput): FinalGrantBinding {
  const admission = admitStageEvidence({
    use: "grant",
    bundle: input.bundle,
    expectation: input.expectation,
    ...(input.ledger ? { ledger: input.ledger } : {}),
  });
  if (admission.admitted) return { granted: true, bundle: input.bundle };
  return { granted: false, requeueFinalStage: true, refusals: admission.refusals };
}

/**
 * Why a Stage 1 test-file bundle cannot stand in for a Stage 1 run (issue
 * #1153). Closed; displayed, never parsed.
 */
export const STAGE1_TEST_EVIDENCE_REFUSALS = [
  "stage-not-loop",
  "no-test-file-record",
  /** Only `passed` and `empty` are a passing Stage 1 (§3). */
  "result-not-passing",
  "suite-binding-changed",
  /** The live selection is unavailable, so nothing can be shown to be the same. */
  "live-selection-unavailable",
  /** Base, file membership, a reason or an unresolved obligation moved. */
  "selection-changed",
  "run-interrupted",
  /** The bundle recorded no end-of-run identity attestation (§8 invariant 1). */
  "identity-recheck-missing",
  "identity-recheck-mismatch",
  "identity-mismatch",
] as const;

export type Stage1TestEvidenceRefusalReason = (typeof STAGE1_TEST_EVIDENCE_REFUSALS)[number];

export interface Stage1TestEvidenceRefusal {
  readonly reason: Stage1TestEvidenceRefusalReason;
  /** Set for `identity-mismatch` and `identity-recheck-mismatch`. */
  readonly mismatches?: readonly StageIdentityMismatch[];
}

export interface Stage1TestEvidenceReuseInput {
  /** A retained `loop` bundle, from any lane. */
  readonly bundle: StageRunResult;
  /** The identity resolved for the Stage 1 run that would otherwise launch. */
  readonly identity: StageEvidenceIdentity;
  /** The suite binding digest that run would use. */
  readonly suiteBindingDigest: string;
  /** The selection that run would execute, resolved now. */
  readonly selection: Stage1TestSelection;
  readonly ledger?: readonly StageRunLedgerEntry[];
}

export type Stage1TestEvidenceReuse =
  | { readonly reusable: true; readonly bundle: StageRunResult }
  | { readonly reusable: false; readonly refusals: readonly Stage1TestEvidenceRefusal[] };

/**
 * Issue #1153 (`docs/changed-file-verification-contract.md` §7's trace, §8
 * invariant 1): may recorded Stage 1 evidence stand in for a Stage 1 run?
 *
 * Only when nothing it was bound to has moved: the same seven-component
 * identity (revision, working tree, plan, session baseline, suite binding and
 * environment) under the #1096 matching law, the same suite binding, and the
 * same selection digest — so a moved Issue base, a newly changed or retained
 * file, or a new unresolved obligation all force a new run. Lane and task
 * attempt are deliberately not compared: the review lane reads the Stage 1
 * evidence the implementation lane recorded for the same revision.
 */
export function evaluateStage1TestEvidenceReuse(input: Stage1TestEvidenceReuseInput): Stage1TestEvidenceReuse {
  const { bundle } = input;
  const refusals: Stage1TestEvidenceRefusal[] = [];
  const refuse = (reason: Stage1TestEvidenceRefusalReason, mismatches?: readonly StageIdentityMismatch[]) => {
    refusals.push(mismatches ? { reason, mismatches } : { reason });
  };

  if (bundle.stageRunId.stage !== "loop") refuse("stage-not-loop");
  const record = bundle.testFiles;
  if (record === undefined) {
    refuse("no-test-file-record");
  } else {
    if (record.result !== "passed" && record.result !== "empty") refuse("result-not-passing");
    if (record.suiteBindingDigest !== input.suiteBindingDigest) refuse("suite-binding-changed");
    if (input.selection.status !== "known") {
      refuse("live-selection-unavailable");
    } else if (
      record.selection.status !== "known"
      || record.selection.selectionDigest !== input.selection.selectionDigest
    ) {
      refuse("selection-changed");
    }
  }

  const entry = input.ledger?.find(
    (candidate) => stageRunKey(candidate.stageRunId) === stageRunKey(bundle.stageRunId),
  );
  if (entry && entry.state !== "recorded") refuse("run-interrupted");
  // §8 invariant 1 attests the identity again at the end of the run: evidence
  // that never recorded that recheck proves nothing about what it ran against.
  if (bundle.identityRecheck === undefined) {
    refuse("identity-recheck-missing");
  } else {
    const recheck = compareStageEvidenceIdentity(bundle.identity, bundle.identityRecheck);
    if (!recheck.matches) refuse("identity-recheck-mismatch", recheck.mismatches);
  }
  const comparison = compareStageEvidenceIdentity(input.identity, bundle.identity);
  if (!comparison.matches) refuse("identity-mismatch", comparison.mismatches);

  return refusals.length === 0 ? { reusable: true, bundle } : { reusable: false, refusals };
}

// ---------------------------------------------------------------------------
// Component derivation (#1096 §4.5) — pure, from already-resolved inputs
// ---------------------------------------------------------------------------

/**
 * `testedRevision` (#1096 §4.5): the stage worktree's resolved `HEAD`,
 * normalized by the shipped #1040 rule.
 *
 * Never `none` — a stage always runs somewhere — so a head that does not resolve
 * or does not normalize is `unknown`, which by #1096 §4.3 rule 4 makes the stage
 * run `unknown` before a single check has launched.
 */
export function deriveTestedRevisionComponent(head: unknown): IdentityComponent {
  const sha = normalizeCommitSha(head);
  if (!sha) return unknownIdentityComponent("head_unresolvable");
  return valueIdentityComponent(sha);
}

/** #1096 §4.5: the `workingTreeState` value of a tree with nothing in it. */
export const WORKING_TREE_CLEAN_VALUE = "clean";

/**
 * #1096 §4.5 rule 5: the fixed sentinel for a path the status lists and that has
 * no current content — a deletion. Distinct from an unreadable path, which makes
 * the component `unknown` rather than taking a sentinel.
 */
export const WORKING_TREE_ABSENT_CONTENT_SENTINEL = "<absent>";

/** One path the shipped porcelain status listed, with its current content. */
export interface WorkingTreeEntry {
  /** The porcelain status code, verbatim. Opaque to core. */
  readonly statusCode: string;
  /** The listed path, verbatim. It enters a digest and never a surface. */
  readonly path: string;
  readonly content: WorkingTreeEntryContent;
}

export type WorkingTreeEntryContent =
  /** The digest of the path's current bytes, or of a symlink's target string. */
  | { readonly state: "fingerprint"; readonly fingerprint: string }
  /** A deletion: the path has no current content (#1096 §4.5 rule 5). */
  | { readonly state: "absent" }
  /** Unreadable, vanished between the listing and the read, or unfingerprintable. */
  | { readonly state: "unreadable"; readonly reason: string };

export type WorkingTreeListing =
  /**
   * The status was read. `entries` is empty for a tree with no modified tracked
   * path and no untracked non-ignored path, and enumerates untracked files
   * individually rather than collapsing a directory into one entry.
   */
  | { readonly state: "listed"; readonly entries: readonly WorkingTreeEntry[] }
  | { readonly state: "unreadable"; readonly reason: string };

/**
 * `workingTreeState` (#1096 §4.5 rule 5): bound to **content**, not to status
 * entries.
 *
 * A path that is already modified, or already untracked, keeps a byte-identical
 * `<status-code> <path>` entry when its contents change again, so a digest over
 * status entries alone would call two different agent diffs the same working
 * tree — exactly the loop case this component exists for. Every path the status
 * lists is therefore fingerprinted by its current bytes.
 *
 * Fingerprinting bytes is not sniffing them: core still cannot say *what*
 * changed, only that this working tree is not the one an earlier bundle ran on.
 * The cost is bounded by the size of the diff and not by the size of the
 * repository, because an ignored path is never listed and therefore never read.
 *
 * A path the seam lists and cannot fingerprint makes the component `unknown` and
 * is never silently skipped — and the reason never names the path, because a
 * public surface carries no path (#1096 §8 rule 10).
 */
export function deriveWorkingTreeStateComponent(listing: WorkingTreeListing): IdentityComponent {
  if (listing.state === "unreadable") {
    return unknownIdentityComponent(`working-tree-status-unreadable:${listing.reason}`);
  }
  if (listing.entries.some((entry) => entry.content.state === "unreadable")) {
    return unknownIdentityComponent("working-tree-path-unfingerprintable");
  }
  if (listing.entries.length === 0) return valueIdentityComponent(WORKING_TREE_CLEAN_VALUE);
  const triples = listing.entries
    .map((entry) => {
      const fingerprint =
        entry.content.state === "fingerprint"
          ? entry.content.fingerprint
          : WORKING_TREE_ABSENT_CONTENT_SENTINEL;
      return `${entry.statusCode} ${entry.path} ${fingerprint}`;
    })
    .sort();
  return valueIdentityComponent(sha256Hex(canonicalJsonStringify(triples)));
}

/**
 * #1096 §4.3 rule 6: a `final` stage launches only on a clean working tree —
 * "clean" meaning no modification to a tracked path, added, modified, deleted,
 * renamed or staged.
 *
 * Untracked, non-ignored paths do **not** block the launch (the review worktree
 * routinely holds runner-written artifacts) but are counted into
 * `workingTreeState`, so two otherwise identical runs stay distinguishable. A
 * `loop` stage has no such precondition: it runs on the agent's uncommitted diff
 * on purpose, which is exactly why `workingTreeState` is a component rather than
 * an assertion.
 *
 * A listing that could not be read is not clean: the runner does not know, and
 * the conservative answer to "may a final stage launch here?" is no.
 */
export function finalStageWorktreeIsClean(listing: WorkingTreeListing): boolean {
  if (listing.state === "unreadable") return false;
  return !listing.entries.some((entry) => !isUntrackedStatusCode(entry.statusCode));
}

/** Porcelain marks an untracked path `??`; everything else touches a tracked one. */
function isUntrackedStatusCode(statusCode: string): boolean {
  return statusCode.trim() === "??";
}

/**
 * The live `session.verification` layer as the caller read it, for the
 * `sessionBaselineDigest` component.
 *
 * `absent` and a declared-but-empty layer are different facts: the first is "no
 * layer at all", which with no checkpoint is the component's only `none` case;
 * the second digests like any other layer.
 */
export type LiveSessionBaseline =
  | { readonly state: "declared"; readonly entries: readonly VerificationPlanSessionBaselineEntry[] }
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly reason: string };

export interface AmendmentIdentityInput {
  /**
   * The shipped #1037 §6.4 classification of this task's stored plan state
   * against its live inputs, from `reconcileVerificationPlan`. Read, never
   * acted on: this contract reads a checkpoint and never writes, repairs or
   * rebases one (#1096 §7.2 rule 2).
   */
  readonly reconciliation: VerificationPlanReconciliation;
  /** The task's stored checkpoint, when it carries one. */
  readonly checkpoint?: VerificationPlanCheckpoint;
  /** #1096 §4.5 rule 6: the baseline is read **live**, never from the checkpoint. */
  readonly liveSessionBaseline: LiveSessionBaseline;
}

/**
 * The three plan-side components — `planDigest`, `planRevisionOrdinal` and
 * `sessionBaselineDigest` — derived from the records the shipped amendment
 * machinery already maintains.
 *
 * This is the integration point the Issue asks for, and the reason there is no
 * second validity model: an operator amendment through `admin task-verification`
 * or ChatOps, and an Issue-refresh revision, both land as a #1037 revision that
 * moves `appliedThroughOrdinal` and the checkpoint's `planDigest`. Stage evidence
 * bound to the old values stops matching *because* the shipped record moved, not
 * because anything here noticed a command changed. Core never compares command
 * bytes and never decides what an amendment meant.
 *
 * `sessionBaselineDigest` is the one component that is deliberately read live
 * (#1096 §4.5 rule 6): #1037 §6.4 rule 5 re-anchors the stored baseline only when
 * a *writing* surface observes the drift, so an operator editing `sessions.json`
 * during a stage run moves nothing the checkpoint holds and rereading a stored
 * digest could never observe that edit. A live layer that differs from a stored
 * one is `unknown` rather than either digest — the run would happen over a
 * session layer #1037 has not yet rebased, and only #1037's rebase resolves that.
 */
export function deriveAmendmentIdentityComponents(
  input: AmendmentIdentityInput,
): Pick<
  StageEvidenceIdentity,
  "planDigest" | "planRevisionOrdinal" | "sessionBaselineDigest"
> {
  return {
    planDigest: derivePlanDigestComponent(input),
    planRevisionOrdinal: derivePlanRevisionOrdinalComponent(input.checkpoint),
    sessionBaselineDigest: deriveSessionBaselineComponent(input),
  };
}

function derivePlanDigestComponent(input: AmendmentIdentityInput): IdentityComponent {
  const { reconciliation, checkpoint } = input;
  if (reconciliation.status === "invalid") {
    return unknownIdentityComponent(`plan_unresolvable:${reconciliation.reason}`);
  }
  // #1037 §6.4 rule 3: a stored digest derivable from no recorded input was
  // written outside the amendment surface. The runner cannot say what plan this
  // task is under, so it says so rather than picking one of the two.
  if (reconciliation.status === "unreconciled") {
    return unknownIdentityComponent("plan_unreconciled");
  }
  // #1096 §4.5: the checkpoint is the source when there is one — #1037 §5.5 rule
  // 1 makes the checkpoint's digest the stored plan digest — and the resolved
  // plan is the source for an unamended task.
  const digest = checkpoint ? checkpoint.planDigest : reconciliation.plan.planDigest;
  if (!isDigest(digest)) return unknownIdentityComponent("plan_digest_unreadable");
  return valueIdentityComponent(digest);
}

function derivePlanRevisionOrdinalComponent(
  checkpoint: VerificationPlanCheckpoint | undefined,
): IdentityComponent {
  // #1096 §4.5: `"0"` for an unamended task. Never `none` — "no amendment yet"
  // is a position on the revision chain, not the absence of one.
  if (!checkpoint) return valueIdentityComponent("0");
  const ordinal = checkpoint.appliedThroughOrdinal;
  if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 0) {
    return unknownIdentityComponent("plan_revision_ordinal_unreadable");
  }
  return valueIdentityComponent(String(ordinal));
}

function deriveSessionBaselineComponent(input: AmendmentIdentityInput): IdentityComponent {
  const { liveSessionBaseline: live, checkpoint } = input;
  if (live.state === "unreadable") {
    return unknownIdentityComponent(`session_baseline_unreadable:${live.reason}`);
  }
  // The only `none`: the session declares no `session.verification` layer at all
  // AND the task carries no checkpoint, so nothing is declared and nothing is
  // stored. That is a stable fact about the configuration, and it matches
  // another run that found the same nothing.
  if (live.state === "absent" && !checkpoint) {
    return noneIdentityComponent("session.verification undeclared");
  }
  const liveDigest = deriveSessionBaselineDigest(
    live.state === "declared" ? live.entries : [],
  );
  if (checkpoint) {
    if (!isDigest(checkpoint.sessionBaselineDigest)) {
      return unknownIdentityComponent("session_baseline_stored_malformed");
    }
    // #1037 §6.4 rule 3's `drifted`, seen from the stage: the stored and live
    // baselines disagree, and only #1037's rebase resolves that.
    if (checkpoint.sessionBaselineDigest !== liveDigest) {
      return unknownIdentityComponent("session_baseline_drifted");
    }
  }
  return valueIdentityComponent(liveDigest);
}

/**
 * The `selectionPolicyDigest` component (#1096 §4.5) has exactly one derivation
 * left: {@link deriveTestSuitePolicyComponent} below.
 *
 * Issue #1155 deleted the other one — `appliedSelectionPolicy` and
 * `deriveSelectionPolicyDigest` over `stagedVerification.selectable`,
 * `finalOnly`, `resultAdapters`, the effective selectable set and the project
 * verification file's check → adapter mapping — together with every setting it
 * read. The configuration that governs a stage run is now the operator's suite
 * binding and nothing else.
 */

/**
 * A stage run's suite binding as the caller resolved it: the binding itself, the
 * configuration fact that the session declares none, or the failure to read one
 * it does declare.
 */
export type TestSuiteConfigurationResolution =
  | { readonly state: "resolved"; readonly configuration: TestSuiteConfigurationInput }
  | { readonly state: "undeclared" }
  | { readonly state: "unreadable"; readonly reason: string };

/**
 * `selectionPolicyDigest` (issue #1153,
 * `docs/changed-file-verification-contract.md` §6 rule 5): the suite binding's
 * digest — bound key, resolved suite command and adapter binding. Since issue
 * #1155 retired the group-selection policy this is the only configuration that
 * governs a stage run, and `recordStageRun` refuses a test-file record whose own
 * `suiteBindingDigest` disagrees with it.
 *
 * `undeclared` is `none`, not `unknown` (#1096 §4.1 rule 2): a session that
 * binds no suite has no stage configuration to attest, which is a configuration
 * fact that compares equal to itself across runs — exactly as a project that
 * declares no environment source does. `unknown` is reserved for a binding the
 * caller could not read, and a session that loses the binding it launched under
 * moves the component from a value to `none`, which still unbinds the run.
 */
export function deriveTestSuitePolicyComponent(resolution: TestSuiteConfigurationResolution): IdentityComponent {
  if (resolution.state === "unreadable") {
    return unknownIdentityComponent(`test_suite_binding_unreadable:${resolution.reason}`);
  }
  if (resolution.state === "undeclared") return noneIdentityComponent("no test suite binding declared");
  return valueIdentityComponent(deriveTestSuiteBindingDigest(resolution.configuration));
}

/**
 * One of the three **declared** environment sources, as the caller found it.
 *
 * `absent` is a configuration fact — no `environmentPrepare` block, no operator
 * token, no capability report emitter — and `unreadable` is a failure. Keeping
 * them apart is what lets a project that declares no environment at all compare
 * equal to itself across runs while one whose declared stamp went missing
 * compares equal to nothing.
 */
export type DeclaredEnvironmentSource =
  | { readonly state: "absent" }
  | { readonly state: "declared"; readonly value: string }
  | { readonly state: "unreadable"; readonly reason: string };

export interface EnvironmentIdentityInput {
  /** #2.4's prepare stamp of the last **successful** prepare in this worktree. */
  readonly prepareStamp?: DeclaredEnvironmentSource;
  /** The operator's `stagedVerification.environmentIdentity` token. */
  readonly operatorToken?: DeclaredEnvironmentSource;
  /** The #916 capability report, when an emitter exists. */
  readonly capabilityReport?: DeclaredEnvironmentSource;
  /**
   * #1096 §4.5 rule 3: when a deadline's process-tree cleanup could not confirm
   * termination, descendants may still be running and the runner cannot say what
   * is executing in that worktree.
   */
  readonly processCleanup?:
    | { readonly state: "confirmed" }
    | { readonly state: "unconfirmed"; readonly reason: string };
}

const ABSENT_SOURCE: DeclaredEnvironmentSource = { state: "absent" };

/**
 * `environmentIdentity` (#1096 §4.5): the declared sources only, digested; never
 * a scan.
 *
 * This is the component the Issue's "no broad nondeterministic environment scan
 * and no mandatory language-specific fingerprint" acceptance rests on. Nothing
 * here enumerates a tool, reads a version, walks a dependency tree or runs a
 * probe: the three sources are the operator's prepare declaration, the
 * operator's opaque token and the #916 report, and a project that declares none
 * of them gets a stable `none` that compares equal to itself forever.
 *
 * An unimplemented source is `none`, not `unknown` (#1096 §4.1 rule 2). #916's
 * capability report has no shipped emitter today, so its absence is a
 * configuration fact for every run in every session, and comparisons behave
 * exactly as if the component were not there — which is what keeps the identity
 * model usable before its sources land.
 */
export function deriveEnvironmentIdentityComponent(
  input: EnvironmentIdentityInput = {},
): IdentityComponent {
  // The taint outranks everything else the component could say: a worktree with
  // an unaccounted process in it is one the runner cannot vouch for at all.
  if (input.processCleanup?.state === "unconfirmed") {
    return unknownIdentityComponent(
      `environment_process_cleanup_unconfirmed:${input.processCleanup.reason}`,
    );
  }
  const sources: readonly [string, DeclaredEnvironmentSource][] = [
    ["prepareStamp", input.prepareStamp ?? ABSENT_SOURCE],
    ["operatorToken", input.operatorToken ?? ABSENT_SOURCE],
    ["capabilityReport", input.capabilityReport ?? ABSENT_SOURCE],
  ];
  for (const [name, source] of sources) {
    if (source.state === "unreadable") {
      return unknownIdentityComponent(`environment_${name}_unreadable:${source.reason}`);
    }
  }
  const declared: Record<string, string> = {};
  for (const [name, source] of sources) {
    if (source.state === "declared") declared[name] = source.value;
  }
  if (Object.keys(declared).length === 0) {
    return noneIdentityComponent("no declared environment source");
  }
  return valueIdentityComponent(sha256Hex(canonicalJsonStringify(declared)));
}
