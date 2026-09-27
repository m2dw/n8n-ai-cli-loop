/**
 * Staged verification, publication side: the `final` stage's §7 rows 7–13 and
 * the stack-ready grant's row-7 precondition (issue #1103 —
 * `docs/staged-verification-contract.md` §13 slices S9 and S10).
 *
 * Two pure questions live here, and nothing else:
 *
 * - **Where does a final stage run route?** {@link routeFinalStageBundle} maps a
 *   recorded bundle onto exactly one of rows 7–13. Only row 7 is grantable.
 * - **May this completion publish `status:stack-ready`?**
 *   {@link decideStackReadyPublication} is read by the shipped label builder
 *   (`enqueueStatusLabelEffects`) over the context the SAME
 *   `completePhaseWithEffects` transaction persists, so the grant is an effect
 *   of the bundle that transaction records (§8 step 5): evidence and grant
 *   commit together or neither does.
 *
 * Deliberately value-import-free of the staged-state / amendment cluster:
 * `outbox-effects.ts` imports this module, and `verification-amendment.ts`
 * imports `outbox-effects.ts`, so a value import of the state module here would
 * close a module cycle. The grant check therefore reads the recorded state
 * structurally — the handler that wrote it already validated it through
 * `recordStageRun`, and every field read below fails closed when absent.
 */

import { normalizeCommitSha } from "./verification-evidence.js";
import {
  resolveStagedVerificationSettings,
  type StagedVerificationConfig,
} from "./staged-verification-config.js";
import type { StageRunResult } from "./staged-verification-state.js";

/** The task-context key of the per-run grant declaration (see {@link FinalStageGrantMarker}). */
export const FINAL_STAGE_GRANT_CONTEXT_KEY = "finalStageGrant";

/** The task-context key of the bounded public record of the last final stage. */
export const FINAL_STAGE_VERIFICATION_CONTEXT_KEY = "finalStageVerification";

/** The task-context key of an approval waiting only on its final stage (see {@link FinalStageApprovalContinuation}). */
export const FINAL_STAGE_APPROVAL_CONTEXT_KEY = "finalStageApproval";

/**
 * A review approval whose final stage ended without a verdict about the change
 * (rows 11 and 13, or a row-7 grant that no longer bound), persisted by the
 * delayed release so the next claim re-runs only the final stage (§7 rule 3:
 * no agent, no cycle).
 *
 * Bound to the HEAD the reviewer approved: an approval is about one revision,
 * so a head that moved since carries no approval and the review runs again.
 */
export interface FinalStageApprovalContinuation {
  readonly headSha: string;
  /** The approving run's review outcome, restored by the handler on resume. */
  readonly approval: Record<string, unknown>;
}

/**
 * The continuation recorded under {@link FINAL_STAGE_APPROVAL_CONTEXT_KEY}, or
 * `undefined` when there is none or it does not bind to `liveHead`. Fails
 * closed: an unreadable head on either side is not a match.
 */
export function readFinalStageApprovalContinuation(
  value: unknown,
  liveHead: unknown,
): FinalStageApprovalContinuation | undefined {
  if (!isRecord(value) || !isRecord(value.approval)) return undefined;
  const recordedHead = normalizeCommitSha(value.headSha);
  const head = normalizeCommitSha(liveHead);
  if (!recordedHead || !head || recordedHead !== head) return undefined;
  return { headSha: recordedHead, approval: value.approval };
}

/**
 * What a review run declares when its final stage earned row 7.
 *
 * Bound to the RUN: task context survives across phase runs, so a marker left by
 * an earlier approval must never publish a later one. The gate compares
 * `runId` to the completion it is building, so a stale marker withholds.
 */
export interface FinalStageGrantMarker {
  readonly runId: string;
  /** `stageRunKey` of the final bundle this run recorded as the R1 bundle. */
  readonly stageRunKey: string;
  /** The approved head the bundle is bound to. */
  readonly headSha: string;
}

// ---------------------------------------------------------------------------
// §7 rows 7–13
// ---------------------------------------------------------------------------

export type FinalStageRow = 7 | 8 | 9 | 10 | 11 | 12 | 13;

/**
 * What the review lane does with a final stage run. Every disposition routes
 * through shipped vocabulary (§7: no new phase-runner member):
 *
 * - `grant` — row 7: the review's `success`, with the grant declared.
 * - `repair` — rows 9 and 10: the shipped `needs_fix` requeue under the review
 *   loop cap, the whole failing set as one fix input.
 * - `operator` — rows 8 and 12: the lane's human handoff (`blocked`).
 * - `rerun` — row 11: re-run from the beginning on the next claim, no cycle.
 * - `host-retry` — row 13: the shipped host-failure delayed retry, no agent.
 */
export type FinalStageDisposition = "grant" | "repair" | "operator" | "rerun" | "host-retry";

export interface FinalStageRoute {
  readonly row: FinalStageRow;
  readonly disposition: FinalStageDisposition;
}

/**
 * §7 rows 7–13 over one final bundle.
 *
 * Row 7 needs all three of `passed`, `complete` and a full selection: a final
 * run whose selection is less than the whole required set is partial by
 * definition (§4.3), and a `passed` bundle that is not complete is row 8 — an
 * integrity failure routed to row 12's operator handoff, never to repair
 * (§7 rule 7).
 */
export function routeFinalStageBundle(
  bundle: Pick<StageRunResult, "outcome" | "complete" | "selection">,
): FinalStageRoute {
  switch (bundle.outcome) {
    case "passed":
      return bundle.complete && bundle.selection.full
        ? { row: 7, disposition: "grant" }
        : { row: 8, disposition: "operator" };
    case "code-failed":
      return { row: 9, disposition: "repair" };
    case "timed-out":
      return { row: 10, disposition: "repair" };
    case "interrupted":
      return { row: 11, disposition: "rerun" };
    case "infrastructure":
      return { row: 13, disposition: "host-retry" };
    case "unknown":
    default:
      // An unrecognized outcome is evidence integrity, never a pass.
      return { row: 12, disposition: "operator" };
  }
}

// ---------------------------------------------------------------------------
// The publication gate (§7 rule 1, §8 step 5)
// ---------------------------------------------------------------------------

export type StackReadyWithholdReason =
  /** No grant was declared by this completion. */
  | "no-grant-declared"
  /** A declaration from another run: task context outlives the run that wrote it. */
  | "grant-declared-by-another-run"
  /** The recorded state names no R1 bundle, or a different one. */
  | "granting-bundle-not-recorded"
  /** The R1 bundle is not a complete, passed, full-set final bundle. */
  | "granting-bundle-not-row-7"
  /** The bundle and the declaration do not name the same attested head. */
  | "head-unbound";

export type StackReadyPublication =
  /** §10 rule 1: staged verification is off — the shipped review-success grant. */
  | { readonly kind: "legacy" }
  | { readonly kind: "grant"; readonly stageRunKey: string }
  | { readonly kind: "withhold"; readonly reason: StackReadyWithholdReason };

export interface StackReadyPublicationInput {
  readonly stagedVerification: StagedVerificationConfig | undefined;
  /** The post-transition task context the completion persists. */
  readonly context: Record<string, unknown> | undefined;
  /** The completion's run id. */
  readonly runId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `stageRunKey`'s flat form, restated here to keep this module cycle-free. */
function stageRunKeyOf(stageRunId: unknown): string | undefined {
  if (!isRecord(stageRunId)) return undefined;
  const { taskAttempt, lane, stage, stageOrdinal } = stageRunId;
  if (typeof taskAttempt !== "number" || typeof lane !== "string") return undefined;
  if (typeof stage !== "string" || typeof stageOrdinal !== "number") return undefined;
  return `${taskAttempt}/${lane}/${stage}/${stageOrdinal}`;
}

/**
 * May a passing review publish the stack-ready marker?
 *
 * For an opted-in session the answer is `grant` only when this very run
 * declared a grant, and the context this transaction persists holds that grant's
 * R1 bundle as a complete, `passed`, full-set **final** bundle bound to the
 * declared head. Everything else — no declaration, a declaration left by an
 * earlier run, a bundle that was never recorded, partial or unbound evidence —
 * withholds, and the caller clears any live marker instead (§7 rule 2).
 *
 * There is no override: no flag and no operator value turns a withhold into a
 * grant (§7 rule 1).
 */
export function decideStackReadyPublication(
  input: StackReadyPublicationInput,
): StackReadyPublication {
  if (!resolveStagedVerificationSettings(input.stagedVerification).enabled) {
    return { kind: "legacy" };
  }
  const context = input.context ?? {};
  const marker = context[FINAL_STAGE_GRANT_CONTEXT_KEY];
  if (!isRecord(marker) || typeof marker.stageRunKey !== "string") {
    return { kind: "withhold", reason: "no-grant-declared" };
  }
  if (marker.runId !== input.runId) {
    return { kind: "withhold", reason: "grant-declared-by-another-run" };
  }
  const state = context.stagedVerification;
  if (!isRecord(state) || state.grantingStageRunKey !== marker.stageRunKey) {
    return { kind: "withhold", reason: "granting-bundle-not-recorded" };
  }
  const bundles = Array.isArray(state.finalBundles) ? state.finalBundles : [];
  const bundle = bundles.find(
    (candidate) => isRecord(candidate) && stageRunKeyOf(candidate.stageRunId) === marker.stageRunKey,
  );
  if (!isRecord(bundle)) {
    return { kind: "withhold", reason: "granting-bundle-not-recorded" };
  }
  const stageRunId = bundle.stageRunId as Record<string, unknown>;
  const selection = isRecord(bundle.selection) ? bundle.selection : {};
  if (
    stageRunId.stage !== "final"
    || bundle.complete !== true
    || bundle.outcome !== "passed"
    || selection.full !== true
  ) {
    return { kind: "withhold", reason: "granting-bundle-not-row-7" };
  }
  const bundleHead = normalizeCommitSha(bundle.headSha);
  const declaredHead = normalizeCommitSha(marker.headSha);
  if (!bundleHead || !declaredHead || bundleHead !== declaredHead) {
    return { kind: "withhold", reason: "head-unbound" };
  }
  return { kind: "grant", stageRunKey: marker.stageRunKey };
}
