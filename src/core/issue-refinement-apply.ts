/**
 * Chain-aware progressive Issue refinement — the application slice's pure half
 * (issue #870, docs/issue-refinement-contract.md §6, §10, §11, §16).
 *
 * This module owns every apply/activation decision that needs no I/O: the §10
 * managed-region splice (append or replace, everything outside the markers
 * preserved byte-for-byte), the §10 trust/idempotency/malformed disposition,
 * the `appliedRegionDigest` of §6, the §16 audit-comment renderer and its
 * nonce-authenticated idempotency marker, and the §6 marker-precondition
 * evaluation for the label transition of §11 step 5. The walk that calls
 * GitHub — re-verifying the live fingerprint, writing the body, posting the
 * comment, moving the labels — lives in
 * `src/handlers/issue-refinement-apply.ts`.
 *
 * Design rules, carried over from #867–#869:
 *
 *  - **Everything here is deterministic.** The same accepted contract, the
 *    same fingerprint, and the same persisted comment nonce always produce
 *    the same rendered region, the same digest, and the same comment, which
 *    is what makes a redelivered or crash-resumed application idempotent
 *    (§10, §6). The one random input — the comment nonce — is minted by the
 *    handler at the row-22 commit point and arrives here as data.
 *  - **Dispositions are literals.** Every refusal names a closed literal an
 *    audit event can carry — never prose, agent output, or a local path.
 *  - **Nothing is derived from labels at activation time.** The label plan
 *    comes from the persisted {@link RefinementActivationPlan} resolved at
 *    admission (§14), so a session rename mid-lane cannot redirect the
 *    transition.
 */

import { createHash } from "crypto";

import type { RefinementPredecessorRecord } from "./issue-refinement.js";
import {
  EXECUTABLE_STATUS_LABELS,
  MANAGED_REGION_BEGIN_PREFIX,
  MANAGED_REGION_END,
} from "./issue-refinement.js";
import type {
  EffectiveTopologyDisposition,
  RefinementLoopContextBlock,
  RefinementRoleRunRecord,
} from "./issue-refinement-loop.js";
import { MANAGED_REGION_FINGERPRINT_PREFIX_CHARS } from "./issue-refinement-loop.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Row 32's fail-closed bound for the handler-performed effects: how many
 * transient GitHub write/read failures one application attempt may absorb
 * (each retried on a later run, after the phase-level delay) before the
 * attempt escalates with reason `effect_undeliverable`. The counter lives on
 * the persisted {@link RefinementApplyProgress}, so it survives crashes and
 * bounds the loop an unreachable provider would otherwise create.
 */
export const MAX_APPLY_TRANSIENT_FAILURES = 5;

/**
 * The `limit` the §16 idempotency scan passes to
 * `RefinementSnapshotSource.readIssueComments` before posting the audit
 * comment: effectively unbounded, so the scan covers the target Issue's FULL
 * comment history. The gap between a delivered comment POST and the
 * persistence of `commentPosted` is not bounded by the retry cadence — a
 * crash can park the attempt for hours — and on an active Issue any number
 * of newer comments can land in between. A bounded most-recent window would
 * push the crashed run's own delivery out of view and the retry would post a
 * duplicate, so the scan must run until the marker is found or the history
 * is exhausted.
 */
export const REFINEMENT_COMMENT_SCAN_ALL = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// §11 step 3 — the write port
// ---------------------------------------------------------------------------

/**
 * The four GitHub writes the application performs (§11 steps 3–5), as a
 * refinement-owned port mirroring the read-only `RefinementSnapshotSource`
 * seam of #868: the gh-backed adapter lives in the CLI layer
 * (`createGhRefinementApplyPort`), tests inject a fake, and the handler layer
 * stays free of `gh` shelling. Every method throws on failure; the caller
 * classifies the throw as a transient, bounded-retry failure (row 32).
 *
 * There is deliberately no read method here: every precondition is evaluated
 * against the read-only snapshot source, so this port cannot be used to
 * widen what the lane can see.
 */
export interface RefinementApplyPort {
  /** §11 step 3: replace the Issue body (the caller splices the region). */
  updateIssueBody(issueNumber: number, body: string): Promise<void>;
  /** §11 step 4: post the single §16 audit comment. */
  postIssueComment(issueNumber: number, body: string): Promise<void>;
  /** §11 step 5, second half. */
  addIssueLabel(issueNumber: number, label: string): Promise<void>;
  /** §11 step 5, first half. A label already absent must not throw. */
  removeIssueLabel(issueNumber: number, label: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// §15 persistence — what the application adds to the block
// ---------------------------------------------------------------------------

/**
 * §10's trust record: one entry per managed region this lane has verifiably
 * written to the Issue, appended the moment the body write is verified. A
 * marker pair on the live body is trusted for in-place replacement only when
 * its fingerprint prefix matches one of these records (or the current
 * attempt's own fingerprint); anything else is attacker-authorable and
 * escalates `unexpected_managed_region`.
 */
export interface RefinementAppliedRegionRecord {
  predecessorFingerprint: string;
  /** The begin-marker prefix (first 12 hex chars), matched by the trust rule. */
  fingerprintPrefix: string;
  /** SHA-256 over the region bytes written (begin line through end line). */
  regionDigest: string;
  appliedAt: string;
}

/**
 * The resumable application position (§11: "a crash between the commit point
 * and step 3 resumes against the same expected region"). `bodyVerified` and
 * `commentPosted` gate re-emitting the row-28/row-30 events on a resumed run
 * — the WRITES themselves are re-decided from live GitHub state, never from
 * this record alone. `transientFailures` is the row-32 bound.
 */
export interface RefinementApplyProgress {
  bodyVerified: boolean;
  commentPosted: boolean;
  /**
   * Per-attempt random hex (mint with `randomBytes(16).toString("hex")`),
   * created by the row-22 commit point and durably persisted BEFORE any
   * GitHub write. It authenticates the §16 idempotency marker: the
   * fingerprint prefix is public (the body's begin marker carries it), so a
   * marker derived from it alone could be forged by any commenter and a
   * crash-retry would take the forgery for its own delivery. The nonce is
   * known only to this local record until the genuine comment publishes it —
   * by which point the audit record it deduplicates already exists.
   */
  commentNonce: string;
  transientFailures: number;
  updatedAt: string;
}

/** #869's block plus the application slice's optional §15 additions. */
export type RefinementApplyContextBlock = RefinementLoopContextBlock & {
  apply?: RefinementApplyProgress;
  appliedRefinements?: RefinementAppliedRegionRecord[];
};

// ---------------------------------------------------------------------------
// §6 / §10 — region digest, extraction, splice, disposition
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The begin-marker prefix this attempt's region carries (§10). */
export function refinementFingerprintPrefix(predecessorFingerprint: string): string {
  return predecessorFingerprint.slice(0, MANAGED_REGION_FINGERPRINT_PREFIX_CHARS);
}

/**
 * §6 `appliedRegionDigest`: SHA-256 over exactly the bytes step 3 writes —
 * the begin marker line through the end marker line inclusive, and nothing
 * outside them. `renderManagedRegion` returns exactly those bytes.
 */
export function computeAppliedRegionDigest(renderedRegion: string): string {
  return sha256(renderedRegion);
}

export type ManagedRegionExtraction =
  | { kind: "absent" }
  | { kind: "malformed" }
  | {
      kind: "present";
      /** Begin line through end line inclusive, joined exactly as split. */
      regionText: string;
      fingerprintPrefix: string | null;
      /** SHA-256 over `regionText` — compared against `appliedRegionDigest`. */
      regionDigest: string;
    };

/**
 * Locate the §10 region and return its exact bytes, for the dispatch-time
 * `appliedRegionDigest` comparison of §6. Same malformed definition as
 * `scanManagedRegion` (which elides; this extracts): an unbalanced pair, more
 * than one pair, or an end marker before a begin marker.
 */
export function extractManagedRegion(body: string | undefined): ManagedRegionExtraction {
  const text = body ?? "";
  const lines = text.split("\n");
  const beginIdx: number[] = [];
  const endIdx: number[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(MANAGED_REGION_BEGIN_PREFIX)) beginIdx.push(i);
    else if (trimmed === MANAGED_REGION_END) endIdx.push(i);
  });
  if (beginIdx.length === 0 && endIdx.length === 0) return { kind: "absent" };
  if (beginIdx.length !== 1 || endIdx.length !== 1 || endIdx[0] < beginIdx[0]) {
    return { kind: "malformed" };
  }
  const regionText = lines.slice(beginIdx[0], endIdx[0] + 1).join("\n");
  const marker = lines[beginIdx[0]].trim();
  const prefix = marker.slice(MANAGED_REGION_BEGIN_PREFIX.length).replace(/-->$/, "").trim();
  return {
    kind: "present",
    regionText,
    fingerprintPrefix: prefix.length > 0 ? prefix : null,
    regionDigest: sha256(regionText),
  };
}

export type ManagedRegionWriteDisposition =
  /** First refinement: append at the end of the body (§10). */
  | { kind: "append" }
  /** Byte-for-byte identical region already present: the no-op case (§10). */
  | { kind: "identical" }
  /** A trusted prior region is replaced in place (§10 trust rule). */
  | { kind: "replace" }
  /** A marker pair no record explains — row 29, `unexpected_managed_region`. */
  | { kind: "untrusted"; fingerprintPrefix: string | null }
  /** Row 29, `malformed_managed_region`. */
  | { kind: "malformed" };

/**
 * Decide the §10 body-write shape for one live body. `trustedPrefixes` is the
 * current attempt's own prefix plus every recorded
 * {@link RefinementAppliedRegionRecord} prefix — the trust rule is keyed on
 * the SQLite record, never on the marker alone. The byte-identity check runs
 * FIRST and needs no trust: only this attempt's own delivered write (or an
 * exact copy of it) can reproduce the rendered bytes, and rewriting them
 * would change nothing.
 */
export function evaluateManagedRegionWrite(
  body: string | undefined,
  renderedRegion: string,
  trustedPrefixes: readonly string[],
): ManagedRegionWriteDisposition {
  const region = extractManagedRegion(body);
  if (region.kind === "malformed") return { kind: "malformed" };
  if (region.kind === "absent") return { kind: "append" };
  if (region.regionText === renderedRegion) return { kind: "identical" };
  if (region.fingerprintPrefix !== null && trustedPrefixes.includes(region.fingerprintPrefix)) {
    return { kind: "replace" };
  }
  return { kind: "untrusted", fingerprintPrefix: region.fingerprintPrefix };
}

/**
 * §10 splice: append on the first refinement (with the single blank-line
 * separator §6's elision removes again), replace in place on a later one.
 * Everything outside the markers is preserved byte-for-byte. The caller has
 * already established the disposition; a malformed body must never reach
 * this function.
 */
export function spliceManagedRegion(body: string | undefined, renderedRegion: string): string {
  const text = body ?? "";
  const region = extractManagedRegion(text);
  if (region.kind === "malformed") {
    throw new Error("spliceManagedRegion called on a malformed managed region");
  }
  if (region.kind === "absent") {
    return text.length === 0 ? renderedRegion : `${text}\n\n${renderedRegion}`;
  }
  const lines = text.split("\n");
  const begin = lines.findIndex((l) => l.trim().startsWith(MANAGED_REGION_BEGIN_PREFIX));
  const end = lines.findIndex((l) => l.trim() === MANAGED_REGION_END);
  return [...lines.slice(0, begin), renderedRegion, ...lines.slice(end + 1)].join("\n");
}

// ---------------------------------------------------------------------------
// §11 step 5 — marker preconditions (§6)
// ---------------------------------------------------------------------------

export type MarkerRemovalDisposition =
  /** The marker is present: perform the removal. */
  | { kind: "perform" }
  /** §6: the end state already holds — a redelivered removal is satisfied. */
  | { kind: "satisfied" };

export function evaluateMarkerRemoval(
  labels: readonly string[],
  markerLabel: string,
): MarkerRemovalDisposition {
  return labels.includes(markerLabel) ? { kind: "perform" } : { kind: "satisfied" };
}

export type StatusAdditionDisposition =
  /** Preconditions hold: perform the addition. */
  | { kind: "perform" }
  /** §6: the executable status this attempt adds is already present. */
  | { kind: "satisfied" }
  /**
   * Row 42: the addition can neither be performed nor treated as done — an
   * executable `status:*` other than the one being added is on the Issue, or
   * the marker is (back) beside the executable status, which is the exact
   * two-marker state §3 refuses.
   */
  | { kind: "conflict"; conflictingLabels: string[] };

/**
 * §6 marker precondition for the addition of §11 step 5: it requires the
 * marker to be absent and no executable `status:*` other than the one being
 * added to be present. Evaluated against the labels observed immediately
 * before the label stage, minus the marker this attempt's own removal just
 * delivered.
 */
export function evaluateStatusAddition(
  labels: readonly string[],
  markerLabel: string,
  implementationStatusLabel: string,
): StatusAdditionDisposition {
  const set = new Set(labels);
  const otherExecutable = EXECUTABLE_STATUS_LABELS.filter(
    (l) => l !== implementationStatusLabel && set.has(l),
  );
  const markerPresent = set.has(markerLabel);
  if (otherExecutable.length > 0 || (markerPresent && set.has(implementationStatusLabel))) {
    return {
      kind: "conflict",
      conflictingLabels: [...otherExecutable, ...(markerPresent ? [markerLabel] : [])],
    };
  }
  if (set.has(implementationStatusLabel)) return { kind: "satisfied" };
  if (markerPresent) return { kind: "conflict", conflictingLabels: [markerLabel] };
  return { kind: "perform" };
}

// ---------------------------------------------------------------------------
// §16 — the audit comment
// ---------------------------------------------------------------------------

/**
 * The §16 idempotency marker. Distinct from the §10 region markers (which
 * agent output may never contain); keyed on the fingerprint prefix because
 * the fingerprint is the identity of the whole attempt (§6) — applying the
 * same fingerprint twice is a no-op, and so is commenting it twice — AND on
 * the {@link RefinementApplyProgress.commentNonce}, because the prefix alone
 * is publicly derivable from the Issue body and a marker any commenter can
 * forge must not stand in for the audit record.
 */
export const REFINEMENT_COMMENT_MARKER_PREFIX = "<!-- ai-refinement:comment fingerprint=";

export function refinementCommentMarker(
  predecessorFingerprint: string,
  commentNonce: string,
): string {
  const prefix = refinementFingerprintPrefix(predecessorFingerprint);
  return `${REFINEMENT_COMMENT_MARKER_PREFIX}${prefix} nonce=${commentNonce} -->`;
}

/**
 * Whether any of the scanned comment bodies already carries this attempt's
 * marker — the fingerprint prefix together with the attempt's persisted
 * nonce. A marker carrying the right prefix but a wrong or missing nonce is
 * not this attempt's delivery (only the local {@link RefinementApplyProgress}
 * knows the nonce before the genuine comment is posted), so it is ignored
 * and the genuine audit comment is still posted.
 */
export function hasRefinementComment(
  commentBodies: readonly string[],
  predecessorFingerprint: string,
  commentNonce: string,
): boolean {
  const marker = refinementCommentMarker(predecessorFingerprint, commentNonce);
  return commentBodies.some((body) => body.includes(marker));
}

export interface RefinementAuditCommentInput {
  predecessorFingerprint: string;
  /** The attempt's persisted {@link RefinementApplyProgress.commentNonce}. */
  commentNonce: string;
  /** §16: Issue numbers, PR numbers, head SHAs — from the snapshot records. */
  predecessors: readonly RefinementPredecessorRecord[];
  refiner: RefinementRoleRunRecord | null;
  critic: RefinementRoleRunRecord | null;
  refinerConfidence: string;
  criticConfidence: string;
  roundsUsed: number;
  malformedAttempts: { refiner: number; critic: number };
  staleRestarts: number;
  topology: readonly EffectiveTopologyDisposition[];
}

function roleLine(role: string, record: RefinementRoleRunRecord | null, confidence: string): string {
  if (!record) return `- ${role}: unrecorded — confidence ${confidence}`;
  const model = record.model ?? "provider default";
  const effort = record.effort ?? "provider default";
  return `- ${role}: \`${record.agentId}\` (model \`${model}\`, effort \`${effort}\`) — confidence ${confidence}`;
}

/**
 * Render the single §16 audit comment. Contains only what §16 allows —
 * snapshot-sourced references, the fingerprint prefix, role identities,
 * literals, counts, and the idempotency marker (whose nonce is random hex
 * carrying no local information) — and never a local path, a
 * run/session/task identifier, raw agent output, or snapshot excerpts. The
 * refined content itself is not restated: the comment points at the managed
 * region.
 *
 * Deliberately silent about the label transition and activation: the comment
 * is posted at §11 step 4, BEFORE the step-5 label stage, so a claim about
 * the activation outcome could be left permanently wrong by a later label
 * conflict or write failure — and §16's allowlist does not include one.
 */
export function renderRefinementAuditComment(input: RefinementAuditCommentInput): string {
  const prefix = refinementFingerprintPrefix(input.predecessorFingerprint);
  const predecessors =
    input.predecessors.length === 0
      ? ["- _none recorded_"]
      : input.predecessors.map((p) => {
          const pr = p.prNumber !== null ? `PR #${p.prNumber}` : "no PR";
          const sha = p.headSha !== null ? `, \`${p.headSha.slice(0, 12)}\`` : "";
          return `- #${p.issueNumber} (${pr}${sha})`;
        });
  const topology =
    input.topology.length === 0
      ? []
      : [
          "",
          "Advisory topology recommendations — recorded for a human, **not** applied:",
          ...input.topology.map(
            (t) => `- \`${t.kind}\` (refiner: ${t.refinerDisposition}, critic: ${t.criticDisposition ?? "unstated"}): ${t.rationale}`,
          ),
        ];
  return [
    "### Issue refinement applied",
    "",
    "The refined contract now lives in the managed region of the Issue body; this comment is the audit metadata for that change and does not restate it.",
    "",
    "Predecessor sources:",
    ...predecessors,
    "",
    `Applied region fingerprint: \`${prefix}\``,
    "",
    roleLine("Refiner", input.refiner, input.refinerConfidence),
    roleLine("Critic", input.critic, input.criticConfidence),
    "- Critic verdict: `pass`",
    `- Rounds used: ${input.roundsUsed}; malformed attempts: refiner ${input.malformedAttempts.refiner}, critic ${input.malformedAttempts.critic}; stale restarts: ${input.staleRestarts}`,
    ...topology,
    "",
    refinementCommentMarker(input.predecessorFingerprint, input.commentNonce),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tolerant readers
// ---------------------------------------------------------------------------

/** The recorded §10 trust prefixes, read tolerantly off a persisted block. */
export function appliedRegionPrefixes(block: RefinementApplyContextBlock): string[] {
  const records = Array.isArray(block.appliedRefinements) ? block.appliedRefinements : [];
  return records
    .map((r) => (r && typeof r === "object" ? r.fingerprintPrefix : undefined))
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}
