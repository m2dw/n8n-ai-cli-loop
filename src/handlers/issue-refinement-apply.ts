/**
 * Chain-aware progressive Issue refinement — the application/activation walk
 * (issue #870, docs/issue-refinement-contract.md §6, §10, §11, §12 rows
 * 22–32 and 42–45, §16).
 *
 * This module walks one ACCEPTED refinement from the row-22 commit point to
 * `activated`, in the same store-free shape as the #869 loop runner: it takes
 * the §15 block, returns the updated block plus the audit events and the
 * task-status instruction, and lets the caller commit them. Its I/O surface is
 * exactly two injected ports — the read-only snapshot source of #868 (every
 * precondition read) and the {@link RefinementApplyPort} write port (the §11
 * step 3–5 mutations) — plus the local artifact directory.
 *
 * The walk is split across two claimed phase runs, and the split is the
 * §11 ordering guarantee:
 *
 *  1. **The commit-point run** (block at `accepted`, row 22): re-read the live
 *     Issue and every predecessor, recompute the fingerprint, and compare. On
 *     a match, persist `applying` + the `appliedRegionDigest` and STOP —
 *     nothing is GitHub-visible until that persistence has durably committed,
 *     so a crash between the check and the first mutation leaves no external
 *     trace and no local record claiming one. On a mismatch, take the stale
 *     path of rows 23/24 without touching anything.
 *  2. **The effect run** (block at `applying`, rows 25–32/42–45): re-verify
 *     the fingerprint (rows 25–27) — including a second target read
 *     taken AFTER the predecessor sweep, so an operator edit landing during
 *     that sweep cannot be silently overwritten — then perform body →
 *     comment → labels in §11's order. The comment and label stages each
 *     REPEAT that full verification immediately before their own dispatch
 *     (a predecessor can move, and the target's title, labels, or body
 *     outside the managed region can be edited, while an earlier stage
 *     delivers — none of which the region digest alone can see),
 *     re-check the target-local preconditions (the §6 marker preconditions
 *     and the `appliedRegionDigest`) against a fresh read, and the label
 *     stage re-decides the status addition from a fresh read once the
 *     marker removal has delivered. The final label delivery is followed, in the
 *     SAME completion transaction, by the row-45 park of the shared task row
 *     (`blocked`/phase `implementation`) — the handler routes it via
 *     `PhaseHandlerResult.refinementActivation`, so the state move and the
 *     park cannot commit separately.
 *
 * One documented deviation from the contract's delivery model: §11 dispatches
 * steps 3–5 through the outbox with per-effect dispatch-time preconditions,
 * on outbox/dispatcher extensions §18 still requires (§6 itself notes the
 * guarantee "is unenforceable until that extension lands"). This slice
 * performs the three stages synchronously inside the claimed run through the
 * injected port — one stage in flight at a time by construction — and keeps
 * the preconditions as per-stage live re-checks. Every stage is idempotent
 * under the fingerprint (§10 byte-identity, the nonce-authenticated §16
 * comment marker, the §6 end-state rules), so a crash anywhere re-enters
 * this walk and converges without a second edit.
 */

import { randomBytes } from "crypto";
import { mkdirSync } from "fs";

import type { RefinementHandoffReason, RefinementLabels } from "../core/issue-refinement.js";
import {
  IMPLEMENTATION_STATUS_LABEL,
  computeIssueSourceFingerprint,
} from "../core/issue-refinement.js";
import type {
  RefinementIssueRead,
  RefinementSnapshotFailureStage,
  RefinementSnapshotSource,
} from "../core/issue-refinement-snapshot.js";
import { buildRefinementSnapshot } from "../core/issue-refinement-snapshot.js";
import { containsFilesystemPath, renderManagedRegion } from "../core/issue-refinement-loop.js";
import type {
  RefinementApplyContextBlock,
  RefinementApplyPort,
} from "../core/issue-refinement-apply.js";
import {
  MAX_APPLY_TRANSIENT_FAILURES,
  REFINEMENT_COMMENT_SCAN_ALL,
  appliedRegionPrefixes,
  computeAppliedRegionDigest,
  evaluateManagedRegionWrite,
  evaluateMarkerRemoval,
  evaluateStatusAddition,
  extractManagedRegion,
  hasRefinementComment,
  refinementFingerprintPrefix,
  renderRefinementAuditComment,
  spliceManagedRegion,
} from "../core/issue-refinement-apply.js";
import { writeArtifactFile } from "./agent-isolation.js";
import type { RefinementLoopEvent } from "./issue-refinement-loop.js";

// ---------------------------------------------------------------------------
// Input/output
// ---------------------------------------------------------------------------

/** The §11 stage a transient failure was recorded against (literals only). */
export type RefinementApplyStep =
  | "verify_fingerprint"
  | "update_issue_body"
  | "post_audit_comment"
  | "remove_marker_label"
  | "add_implementation_label";

export type RefinementApplyOutcome =
  /** Row 22 committed: `applying` + `appliedRegionDigest` persist; effects run next. */
  | { kind: "committed" }
  /** Row 45: everything delivered; the caller parks the row per the activation plan. */
  | { kind: "activated" }
  /** Rows 23/26/43: the draft is discarded and the Issue re-snapshots. */
  | { kind: "stale_restart"; trigger: "fingerprint" | "region"; staleRestarts: number }
  /** Rows 24/27/29/32/42/44: §13 handoff; the local half is on the block. */
  | { kind: "escalated"; reason: RefinementHandoffReason }
  /** A provider/network error while re-verifying: nothing moved, retry later. */
  | { kind: "verify_failed"; stage: RefinementSnapshotFailureStage | "issue"; error: string }
  /** A transient GitHub write failure below the row-32 bound: retry later. */
  | { kind: "write_failed"; step: RefinementApplyStep; error: string; transientFailures: number }
  /** The block is not in an applicable state; nothing was touched. */
  | { kind: "refused"; detail: string };

export interface RefinementApplyRunResult {
  outcome: RefinementApplyOutcome;
  /** The updated §15 block; the caller persists it under `context.refinement`. */
  block: RefinementApplyContextBlock;
  events: RefinementLoopEvent[];
  /** §13: `ready_for_human` on every escalation; `null` otherwise. */
  taskStatus: "ready_for_human" | null;
  artifacts: string[];
}

export interface RefinementApplyDeps {
  /** Read-only snapshot/precondition port (#868). */
  source: RefinementSnapshotSource;
  /** The §11 step 3–5 write port. */
  applyPort: RefinementApplyPort;
  now?: () => number;
}

export interface RefinementApplyInput {
  issueNumber: number;
  block: RefinementApplyContextBlock;
  /** `session.labels.stackReady` (§4), for the fingerprint re-verification. */
  stackReadyLabel: string;
  /** `<artifactRoot>/issue-refinement/issue-<n>/<runId>` (§15); created if absent. */
  artifactDir: string;
  runId: string;
}

// ---------------------------------------------------------------------------
// Walk state
// ---------------------------------------------------------------------------

interface ApplyState {
  block: RefinementApplyContextBlock;
  events: RefinementLoopEvent[];
  artifacts: string[];
  issueNumber: number;
  runId: string;
  artifactDir: string;
  startedAt: string;
  nowMs: () => number;
  outcome?: RefinementApplyOutcome;
  taskStatus: "ready_for_human" | null;
}

function iso(state: ApplyState): string {
  return new Date(state.nowMs()).toISOString();
}

/** Same §15 envelope as the loop runner: literals, counters, identifiers. */
function baseEventData(state: ApplyState): Record<string, unknown> {
  const c = state.block.counters;
  return {
    issueNumber: state.issueNumber,
    runId: state.runId,
    state: state.block.state,
    predecessors: state.block.predecessors.map((p) => p.issueNumber),
    predecessorFingerprint: state.block.predecessorFingerprint,
    counters: {
      rounds: c.rounds,
      malformedRefiner: c.malformedAttempts.refiner,
      malformedCritic: c.malformedAttempts.critic,
      agentFailuresRefiner: c.agentFailures.refiner,
      agentFailuresCritic: c.agentFailures.critic,
      staleRestarts: c.staleRestarts,
    },
    at: iso(state),
  };
}

function emitEvent(state: ApplyState, type: string, data: Record<string, unknown>): void {
  state.events.push({ type, data: { ...baseEventData(state), ...data } });
}

function touch(state: ApplyState): void {
  state.block.updatedAt = iso(state);
}

function writeArtifact(state: ApplyState, name: string, content: string): void {
  writeArtifactFile(state.artifactDir, name, content);
  state.artifacts.push(name);
}

/** §13's local half, identical to the loop runner's. */
function escalate(
  state: ApplyState,
  reason: RefinementHandoffReason,
  data: Record<string, unknown> = {},
): void {
  state.block.state = "escalated_human";
  state.block.handoffReason = reason;
  touch(state);
  emitEvent(state, "refinement.escalated.human", { reason, ...data });
  state.taskStatus = "ready_for_human";
  state.outcome = { kind: "escalated", reason };
}

/**
 * Rows 23/26/43 (or 24/27/44 at the cap): discard the accepted draft, return
 * the Issue to `eligible` for a clean re-snapshot, and spend one stale
 * restart. The applied-region trust records survive deliberately: a region
 * already written under the previous fingerprint is a recorded applied
 * refinement, which is what lets the NEXT attempt replace it in place (§11).
 */
function staleOrEscalate(
  state: ApplyState,
  trigger: "fingerprint" | "region",
  detail: Record<string, unknown>,
): void {
  const counters = state.block.counters;
  const atCap = counters.staleRestarts >= state.block.limits.maxStaleRestartsPerIssue;
  if (atCap) {
    escalate(state, trigger === "region" ? "managed_region_modified" : "stale_inputs", detail);
    return;
  }
  counters.staleRestarts += 1;
  state.block.state = "eligible";
  state.block.handoffReason = null;
  delete state.block.accepted;
  delete state.block.apply;
  delete state.block.pendingRetry;
  state.block.appliedRegionDigest = null;
  touch(state);
  emitEvent(state, "refinement.stale.detected", { trigger, ...detail });
  state.outcome = { kind: "stale_restart", trigger, staleRestarts: counters.staleRestarts };
}

/**
 * Row 32's bound for a handler-performed effect: a transient GitHub failure
 * is retried on a later run (the caller applies the phase-level delay) up to
 * {@link MAX_APPLY_TRANSIENT_FAILURES}, then the attempt fails closed as
 * `effect_undeliverable`. No later application stage runs either way.
 */
function transientFailure(state: ApplyState, step: RefinementApplyStep, err: unknown): void {
  const progress = state.block.apply;
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  const failures = (progress?.transientFailures ?? 0) + 1;
  if (progress) {
    progress.transientFailures = failures;
    progress.updatedAt = iso(state);
  }
  touch(state);
  if (failures > MAX_APPLY_TRANSIENT_FAILURES) {
    escalate(state, "effect_undeliverable", { step, transientFailures: failures });
    return;
  }
  state.outcome = { kind: "write_failed", step, error: message, transientFailures: failures };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Run one application attempt against the block's current state (`accepted`
 * or `applying`). See the module header for the two-run shape and the
 * delivery-model deviation.
 */
export async function executeRefinementApply(
  input: RefinementApplyInput,
  deps: RefinementApplyDeps,
): Promise<RefinementApplyRunResult> {
  const nowMs = deps.now ?? Date.now;
  const block = structuredClone(input.block) as RefinementApplyContextBlock;
  const state: ApplyState = {
    block,
    events: [],
    artifacts: [],
    issueNumber: input.issueNumber,
    runId: input.runId,
    artifactDir: input.artifactDir,
    startedAt: new Date(nowMs()).toISOString(),
    nowMs,
    taskStatus: null,
  };
  const refuse = (detail: string): RefinementApplyRunResult => ({
    outcome: { kind: "refused", detail },
    block: input.block,
    events: [],
    taskStatus: null,
    artifacts: [],
  });

  if (block.state !== "accepted" && block.state !== "applying") {
    return refuse(`state:${block.state}`);
  }
  const accepted = block.accepted;
  const fingerprint = block.predecessorFingerprint;
  const plan = block.activationPlan;
  if (!accepted || !fingerprint || !plan) {
    // An accepted/applying block always carries all three; a block that lost
    // one was hand-edited, and applying anything from it would publish
    // content no critic passed.
    return refuse(
      !accepted ? "missing:accepted" : !fingerprint ? "missing:predecessorFingerprint" : "missing:activationPlan",
    );
  }

  // Deterministic re-render (§10): the region, its digest, and the §16 comment
  // are pure functions of the accepted contract and the fingerprint.
  const renderedRegion = renderManagedRegion(accepted.contract, fingerprint);
  const regionDigest = computeAppliedRegionDigest(renderedRegion);
  const prefix = refinementFingerprintPrefix(fingerprint);
  if (block.state === "applying" && block.appliedRegionDigest !== regionDigest) {
    // The persisted commit point does not match what this block re-renders:
    // the block was edited between runs. Fail closed rather than write bytes
    // the recorded digest never covered.
    return refuse("appliedRegionDigest:drift");
  }

  mkdirSync(input.artifactDir, { recursive: true });
  const finish = (): RefinementApplyRunResult => {
    const manifest = {
      runId: state.runId,
      issueNumber: state.issueNumber,
      startedAt: state.startedAt,
      finishedAt: iso(state),
      outcome: state.outcome ?? null,
      state: state.block.state,
      handoffReason: state.block.handoffReason,
      predecessorFingerprint: state.block.predecessorFingerprint,
      appliedRegionDigest: state.block.appliedRegionDigest,
      apply: state.block.apply ?? null,
      counters: state.block.counters,
      artifacts: [...state.artifacts, "apply-manifest.json"],
    };
    writeArtifactFile(state.artifactDir, "apply-manifest.json", JSON.stringify(manifest, null, 2));
    state.artifacts.push("apply-manifest.json");
    return {
      outcome: state.outcome ?? { kind: "refused", detail: "internal:no-outcome" },
      block: state.block,
      events: state.events,
      taskStatus: state.taskStatus,
      artifacts: state.artifacts,
    };
  };

  // ---------------------------------------------------------------------
  // §11 step 1 / rows 22–27: re-read the live Issue AND every predecessor,
  // recompute the fingerprint, and compare — before anything is persisted
  // and before any mutation. A snapshot that can no longer be captured
  // (a predecessor lost its usable shape, the chain moved, fan-in grew) is
  // the same fact as a mismatching fingerprint: the inputs the contract was
  // accepted under no longer hold.
  // ---------------------------------------------------------------------
  let target: RefinementIssueRead;
  try {
    target = await deps.source.readIssue(input.issueNumber);
  } catch (err) {
    state.outcome = {
      kind: "verify_failed",
      stage: "issue",
      error: err instanceof Error ? err.message : String(err),
    };
    return finish();
  }
  const laneLabels: RefinementLabels = {
    marker: plan.markerLabel,
    implementationStatus: plan.implementationStatusLabel ?? IMPLEMENTATION_STATUS_LABEL,
  };
  const snapshotResult = await buildRefinementSnapshot({
    target,
    source: deps.source,
    limits: block.limits,
    laneLabels,
    stackReadyLabel: input.stackReadyLabel,
    now: iso(state),
  });
  if (snapshotResult.kind === "failed") {
    state.outcome = {
      kind: "verify_failed",
      stage: snapshotResult.stage,
      error: snapshotResult.error,
    };
    return finish();
  }
  if (snapshotResult.kind !== "captured") {
    staleOrEscalate(state, "fingerprint", {
      reason: `snapshot_${snapshotResult.kind}`,
      snapshotReason: snapshotResult.reason,
    });
    return finish();
  }
  if (snapshotResult.snapshot.predecessorFingerprint !== fingerprint) {
    // Rows 23/24 (from `accepted`) or 26/27 (from `applying`).
    staleOrEscalate(state, "fingerprint", { reason: "fingerprint_mismatch" });
    return finish();
  }

  // ---------------------------------------------------------------------
  // Row 22 — the commit point. Persist `applying` + the digest and stop:
  // the first GitHub mutation belongs to a LATER run, whose starting state
  // is this durably committed record.
  // ---------------------------------------------------------------------
  if (block.state === "accepted") {
    block.state = "applying";
    block.appliedRegionDigest = regionDigest;
    block.apply = {
      bodyVerified: false,
      commentPosted: false,
      // Minted here — the one point that durably persists BEFORE any GitHub
      // write — so a crash-retry can authenticate the §16 comment it already
      // delivered. Nothing public carries this value until that comment.
      commentNonce: randomBytes(16).toString("hex"),
      transientFailures: 0,
      updatedAt: iso(state),
    };
    touch(state);
    emitEvent(state, "refinement.accepted.persisted", {
      appliedRegionDigest: regionDigest,
      regionBytes: Buffer.byteLength(renderedRegion, "utf8"),
    });
    writeArtifact(state, "managed-region.md", renderedRegion);
    writeArtifact(
      state,
      "accepted-refinement.json",
      JSON.stringify(
        {
          issueNumber: input.issueNumber,
          runId: input.runId,
          predecessorFingerprint: fingerprint,
          appliedRegionDigest: regionDigest,
          accepted,
        },
        null,
        2,
      ),
    );
    state.outcome = { kind: "committed" };
    return finish();
  }

  // ---------------------------------------------------------------------
  // Rows 26/27, dispatch-time — re-read the target immediately before the
  // first mutation. The fingerprint check above certified `target`, the read
  // taken BEFORE the predecessor sweep; that sweep is the long pole of the
  // run, and an operator edit landing during it is invisible both to the
  // snapshot's fingerprint and to a body PATCH constructed from `target`.
  // The write port has no conditional-update seam, so a fresh read directly
  // ahead of the dispatch is the narrowest window available, and every stage
  // below works from it. Managed-region changes are deliberately not part of
  // this comparison — the region is elided from the §6 digest, and the §10
  // dispositions below decide those against this same fresh read.
  // ---------------------------------------------------------------------
  let liveIssue: RefinementIssueRead;
  try {
    liveIssue = await deps.source.readIssue(input.issueNumber);
  } catch (err) {
    state.outcome = {
      kind: "verify_failed",
      stage: "issue",
      error: err instanceof Error ? err.message : String(err),
    };
    return finish();
  }
  const targetHalf = (issue: RefinementIssueRead): string =>
    computeIssueSourceFingerprint({
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      laneLabels,
    }).digest;
  if (targetHalf(liveIssue) !== targetHalf(target)) {
    // The same staleness fact as a mismatching fingerprint, caught in the
    // window the snapshot could not see.
    staleOrEscalate(state, "fingerprint", { reason: "target_changed" });
    return finish();
  }

  // ---------------------------------------------------------------------
  // Rows 26/27, held at stage granularity — the verification above certifies
  // only the walk's ENTRY. Every input in the recorded fingerprint — each
  // predecessor as much as the target's own title, labels, and body outside
  // the managed region — can move while an earlier stage delivers, and the
  // per-stage region re-reads below deliberately cannot see any of that. So
  // the stages after the body write re-run the FULL snapshot comparison
  // immediately before their own dispatch. The managed region is elided
  // from the §6 digest, which is what keeps the body this walk has already
  // written from reading as drift here. The sweep is the long pole exactly
  // as it is at run start, so the same two-read shape applies: the snapshot
  // certifies the read it swept from, and a second read taken AFTER the
  // sweep is what the calling stage's own preconditions evaluate against. A
  // provider failure is charged to the stage about to dispatch (row 32). A
  // mismatch is returned as a verdict rather than dispatched here: at the
  // label stage the row-42 conflict disposition outranks generic staleness
  // (an executable status added mid-run has a §13 escalation of its own,
  // which a restart would only rediscover after a wasted refinement round),
  // so the caller decides where the verdict lands in its own check order.
  // ---------------------------------------------------------------------
  const verifyBeforeStage = async (
    step: RefinementApplyStep,
    stage: string,
  ): Promise<{ issue: RefinementIssueRead; stale: Record<string, unknown> | null } | null> => {
    let swept: RefinementIssueRead;
    try {
      swept = await deps.source.readIssue(input.issueNumber);
    } catch (err) {
      transientFailure(state, step, err);
      return null;
    }
    const recheck = await buildRefinementSnapshot({
      target: swept,
      source: deps.source,
      limits: block.limits,
      laneLabels,
      stackReadyLabel: input.stackReadyLabel,
      now: iso(state),
    });
    if (recheck.kind === "failed") {
      transientFailure(state, step, new Error(`${recheck.stage}: ${recheck.error}`));
      return null;
    }
    if (recheck.kind !== "captured") {
      // A snapshot that can no longer be captured is the same fact as a
      // mismatching fingerprint (see the run-start check) and is never
      // ambiguous with a row-42 conflict, so it dispatches directly.
      staleOrEscalate(state, "fingerprint", {
        reason: `snapshot_${recheck.kind}`,
        snapshotReason: recheck.reason,
        stage,
      });
      return null;
    }
    let fresh: RefinementIssueRead;
    try {
      fresh = await deps.source.readIssue(input.issueNumber);
    } catch (err) {
      transientFailure(state, step, err);
      return null;
    }
    if (recheck.snapshot.predecessorFingerprint !== fingerprint) {
      return { issue: fresh, stale: { reason: "fingerprint_mismatch", stage } };
    }
    if (targetHalf(fresh) !== targetHalf(swept)) {
      return { issue: fresh, stale: { reason: "target_changed", stage } };
    }
    return { issue: fresh, stale: null };
  };

  // ---------------------------------------------------------------------
  // Rows 28/29/43/44 — the body stage.
  // ---------------------------------------------------------------------
  const progress = block.apply;
  const commentNonce =
    typeof progress?.commentNonce === "string" ? progress.commentNonce : "";
  if (progress === undefined || commentNonce.length === 0) {
    // The row-22 commit point always persists this record — and with it the
    // §16 comment nonce — before any GitHub write, so an `applying` block
    // missing either was hand-edited. Recreating them here would mint a
    // fresh nonce AFTER a comment may already have been delivered under the
    // lost one; the §16 scan could then never recognise that delivery and
    // would post a duplicate. Fail closed instead.
    return refuse(progress === undefined ? "missing:apply" : "missing:commentNonce");
  }

  if (progress.bodyVerified) {
    // The region this attempt already wrote is a precondition for everything
    // after it (§6): a mismatch here means it was edited between runs.
    const live = extractManagedRegion(liveIssue.body);
    if (live.kind !== "present" || live.regionDigest !== regionDigest) {
      staleOrEscalate(state, "region", { reason: "region_mismatch", stage: "resume" });
      return finish();
    }
  } else {
    const disposition = evaluateManagedRegionWrite(liveIssue.body, renderedRegion, [
      prefix,
      ...appliedRegionPrefixes(block),
    ]);
    if (disposition.kind === "malformed") {
      escalate(state, "malformed_managed_region", {});
      return finish();
    }
    if (disposition.kind === "untrusted") {
      // §10 trust rule: an Issue body is attacker-authorable, and a marker
      // pair no local record explains must not steer what the lane overwrites.
      escalate(state, "unexpected_managed_region", {});
      return finish();
    }
    if (disposition.kind === "identical") {
      // A previous run delivered the write but crashed before committing:
      // the §10 byte-identity no-op completes it now.
      progress.bodyVerified = true;
      progress.updatedAt = iso(state);
    } else {
      // The prior body is the auditable local record the update replaces.
      writeArtifact(state, "prior-issue-body.md", liveIssue.body ?? "");
      const nextBody = spliceManagedRegion(liveIssue.body, renderedRegion);
      try {
        await deps.applyPort.updateIssueBody(input.issueNumber, nextBody);
      } catch (err) {
        transientFailure(state, "update_issue_body", err);
        return finish();
      }
      // §11: the label transition (and the comment before it) proceed only
      // against the region this step actually wrote — verify from a fresh
      // read, not from the write's success alone.
      try {
        liveIssue = await deps.source.readIssue(input.issueNumber);
      } catch (err) {
        transientFailure(state, "update_issue_body", err);
        return finish();
      }
      const written = extractManagedRegion(liveIssue.body);
      if (written.kind !== "present" || written.regionDigest !== regionDigest) {
        staleOrEscalate(state, "region", { reason: "region_mismatch", stage: "verify_body" });
        return finish();
      }
      progress.bodyVerified = true;
      progress.updatedAt = iso(state);
    }
    const records = Array.isArray(block.appliedRefinements) ? block.appliedRefinements : [];
    if (!records.some((r) => r.predecessorFingerprint === fingerprint)) {
      records.push({
        predecessorFingerprint: fingerprint,
        fingerprintPrefix: prefix,
        regionDigest,
        appliedAt: iso(state),
      });
    }
    block.appliedRefinements = records;
    touch(state);
    emitEvent(state, "refinement.applied", {
      mode: disposition.kind,
      regionBytes: Buffer.byteLength(renderedRegion, "utf8"),
    });
  }

  // ---------------------------------------------------------------------
  // Row 30 — the audit comment, idempotent on the nonce-authenticated
  // fingerprint marker (§16). The scan covers the FULL comment history —
  // the crash window between a delivered POST and the persistence of
  // `commentPosted` is unbounded, so newer discussion must never push this
  // attempt's own delivery out of view — and matches only the marker
  // carrying the nonce the commit point persisted, so a forged marker from
  // an untrusted commenter cannot stand in for the audit record.
  // ---------------------------------------------------------------------
  if (!progress.commentPosted) {
    let existing: readonly { body: string }[];
    try {
      existing = await deps.source.readIssueComments(
        input.issueNumber,
        REFINEMENT_COMMENT_SCAN_ALL,
      );
    } catch (err) {
      transientFailure(state, "post_audit_comment", err);
      return finish();
    }
    if (hasRefinementComment(existing.map((c) => c.body), fingerprint, commentNonce)) {
      progress.commentPosted = true;
      progress.updatedAt = iso(state);
      touch(state);
      emitEvent(state, "refinement.comment.posted", { deduplicated: true });
    } else {
      // The scan above certified only that this attempt's own comment is
      // still undelivered. The POST below is the next public write, so the
      // full fingerprint is re-verified immediately ahead of it: a
      // predecessor moving — or an operator edit outside the managed region
      // — after the run-start check must take the stale path here, not ride
      // into a public audit record for a contract its inputs no longer back.
      const preComment = await verifyBeforeStage("post_audit_comment", "pre_comment");
      if (preComment === null) return finish();
      if (preComment.stale !== null) {
        staleOrEscalate(state, "fingerprint", preComment.stale);
        return finish();
      }
      const comment = renderRefinementAuditComment({
        predecessorFingerprint: fingerprint,
        commentNonce,
        predecessors: block.predecessors,
        refiner: block.execution?.refiner ?? null,
        critic: block.execution?.critic ?? null,
        refinerConfidence: accepted.refinerConfidence,
        criticConfidence: accepted.criticConfidence,
        roundsUsed: accepted.roundsUsed,
        malformedAttempts: block.counters.malformedAttempts,
        staleRestarts: block.counters.staleRestarts,
        topology: accepted.topology,
      });
      if (containsFilesystemPath(comment)) {
        // Defense in depth for the §16 "never published" list: every input is
        // already validated path-free (§17), so this firing means a rendering
        // bug — refuse to publish rather than leak. Returned through
        // `finish()` so the already-verified body stage (and its §10 trust
        // record) still persists.
        state.outcome = { kind: "refused", detail: "comment:path-guard" };
        return finish();
      }
      writeArtifact(state, "audit-comment.md", comment);
      try {
        await deps.applyPort.postIssueComment(input.issueNumber, comment);
      } catch (err) {
        transientFailure(state, "post_audit_comment", err);
        return finish();
      }
      progress.commentPosted = true;
      progress.updatedAt = iso(state);
      touch(state);
      emitEvent(state, "refinement.comment.posted", {});
    }
  }

  // ---------------------------------------------------------------------
  // Rows 31/42 — labels last, removal before addition (§11 step 5). The
  // stage opens with the full stage-entry verification, so the §6 marker
  // preconditions and the region precondition are evaluated against
  // post-comment live state AND the fingerprint is re-compared before the
  // transition that makes the Issue implementation-eligible. The staleness
  // verdict is dispatched only after the row-42 conflict evaluation below
  // (which outranks it), but always before any label write.
  // ---------------------------------------------------------------------
  const labelStage = await verifyBeforeStage("remove_marker_label", "labels");
  if (labelStage === null) return finish();
  liveIssue = labelStage.issue;
  const preLabelRegion = extractManagedRegion(liveIssue.body);
  if (preLabelRegion.kind !== "present" || preLabelRegion.regionDigest !== regionDigest) {
    // Rows 43/44: activation must not complete for a region the critic did
    // not pass.
    staleOrEscalate(state, "region", { reason: "region_mismatch", stage: "labels" });
    return finish();
  }
  const labels = [...liveIssue.labels];
  const removal = evaluateMarkerRemoval(labels, plan.markerLabel);
  // Row 42 is decided BEFORE the removal is performed, against the label set
  // the removal would leave behind: an executable `status:*` already beside
  // the marker means the addition can never dispatch, and §13 requires an
  // escalation to leave `status:needs-refinement` in place — removing it
  // first and then escalating would strand the Issue on the foreign
  // executable status alone. The marker is elided from that set ONLY while
  // the status this attempt adds is still absent: the marker already sitting
  // beside `status:needs-implementation` is the exact two-marker state §3
  // refuses, and eliding it would read that state as `satisfied` — removing
  // the marker and activating instead of escalating.
  const markerBesideStatus =
    labels.includes(plan.markerLabel) && labels.includes(plan.implementationStatusLabel);
  let addition = evaluateStatusAddition(
    markerBesideStatus ? labels : labels.filter((l) => l !== plan.markerLabel),
    plan.markerLabel,
    plan.implementationStatusLabel,
  );
  if (addition.kind === "conflict") {
    escalate(state, "marker_precondition_failed", {
      conflictingLabels: addition.conflictingLabels,
    });
    return finish();
  }
  if (labelStage.stale !== null) {
    staleOrEscalate(state, "fingerprint", labelStage.stale);
    return finish();
  }
  if (removal.kind === "perform") {
    try {
      await deps.applyPort.removeIssueLabel(input.issueNumber, plan.markerLabel);
    } catch (err) {
      transientFailure(state, "remove_marker_label", err);
      return finish();
    }
    // The dispositions above were decided from the PRE-removal read, and the
    // removal dispatch opens one more await window before the addition — one
    // that admits a predecessor change as readily as a target edit. The
    // addition below is the write that makes the Issue implementation-
    // eligible, so it gets the FULL stage-entry verification again: the
    // fingerprint sweep, the §6 region precondition (rows 43/44), and the
    // row-42 disposition are all re-evaluated against post-removal live
    // state. The marker and status labels are lane-owned and elided from the
    // hashed label set, so the removal this walk just performed does not
    // read as drift here.
    const postRemoval = await verifyBeforeStage("add_implementation_label", "post_removal");
    if (postRemoval === null) return finish();
    liveIssue = postRemoval.issue;
    const postRemovalRegion = extractManagedRegion(liveIssue.body);
    if (postRemovalRegion.kind !== "present" || postRemovalRegion.regionDigest !== regionDigest) {
      staleOrEscalate(state, "region", { reason: "region_mismatch", stage: "post_removal" });
      return finish();
    }
    addition = evaluateStatusAddition(
      liveIssue.labels,
      plan.markerLabel,
      plan.implementationStatusLabel,
    );
    // An executable status (or a re-added marker) landing in the window must
    // take the row-42 escalation, not have a second executable status stacked
    // beside it — and it outranks the stale verdict, exactly as at stage
    // entry.
    if (addition.kind === "conflict") {
      escalate(state, "marker_precondition_failed", {
        conflictingLabels: addition.conflictingLabels,
        stage: "post_removal",
      });
      return finish();
    }
    if (postRemoval.stale !== null) {
      staleOrEscalate(state, "fingerprint", postRemoval.stale);
      return finish();
    }
  }
  if (addition.kind === "perform") {
    try {
      await deps.applyPort.addIssueLabel(input.issueNumber, plan.implementationStatusLabel);
    } catch (err) {
      transientFailure(state, "add_implementation_label", err);
      return finish();
    }
  }

  // ---------------------------------------------------------------------
  // Row 45 — activation. The caller commits this state move and the park of
  // the shared task row (per the persisted activation plan, `blocked`/phase
  // `implementation`, `context.assignment` untouched) in ONE TaskStore
  // transaction, via the handler's routing override.
  // ---------------------------------------------------------------------
  block.state = "activated";
  block.handoffReason = null;
  progress.updatedAt = iso(state);
  touch(state);
  emitEvent(state, "refinement.activated", {
    parked: { status: plan.targetStatus, phase: plan.targetPhase },
    agentLabel: plan.agentLabel,
    implementationAgent: plan.implementationAgent,
  });
  state.outcome = { kind: "activated" };
  return finish();
}
