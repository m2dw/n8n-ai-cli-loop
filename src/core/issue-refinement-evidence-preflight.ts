/**
 * §5.2 required-evidence preflight (issue #1003,
 * docs/issue-refinement-contract.md §5.2, §12 row 48, §13).
 *
 * Issue #983 captures the §5.1 declared predecessor contract evidence and
 * records, entry by entry, what could not be captured and why. It deliberately
 * stops there. This module is the disposition: given that immutable record, it
 * says whether the refinement may run at all.
 *
 * The failure it exists to prevent is the reported #951/#950 one. When an Issue
 * makes a predecessor's exported code contract authoritative and the snapshot
 * cannot carry that contract, the refiner has nothing to write the draft from
 * but inference, the critic correctly objects that the inference has no
 * snapshot basis, and the two burn the round cap converging on evidence neither
 * of them has. Re-running changes nothing, because nothing about the evidence
 * changed. So the lane stops FIRST — before either agent is invoked, on the
 * capture record alone — and hands the operator a `evidence_required` handoff
 * naming what was asked for and what happened to it.
 *
 * Two properties make that stop safe to automate:
 *
 *  - It is **pure and deterministic**. Every input is a literal already frozen
 *    into the snapshot, so the same snapshot always yields the same decision,
 *    and a retry that changed nothing reaches the same handoff without spending
 *    an agent invocation.
 *  - It **fails closed on unknown requiredness**. A declaration that never
 *    named a selection — malformed as a unit, an entry the schema rejected, a
 *    selection past the cap — carries no `required` flag to read, and the one
 *    reading that cannot be wrong is "assume the operator meant it".
 *
 * The module holds no port, reads no file, and knows nothing about GitHub: the
 * handoff it feeds travels the existing durable ready-for-human path (§13)
 * unchanged, and the operator's way back out is the same §12 row 36 recovery
 * every other handoff uses.
 */

import {
  REFINEMENT_EVIDENCE_OMISSION_REASONS,
  type RefinementSnapshot,
  type RefinementSnapshotEvidence,
} from "./issue-refinement-snapshot.js";

/**
 * Why one declared selection is not usable evidence.
 *
 * The §5.1 omission vocabulary verbatim, plus `truncated` — the one gap that is
 * not an omission. A required selection whose bytes were cut IS in the snapshot
 * and is still not the predecessor's contract: the agents are told to treat
 * conclusions depending on the missing remainder as unsupported, which is the
 * same dead end reached by a different road. It is listed last because it is
 * this section's addition, not §5.1's.
 */
export const REFINEMENT_EVIDENCE_GAP_REASONS = [
  ...REFINEMENT_EVIDENCE_OMISSION_REASONS,
  "truncated",
] as const;
export type RefinementEvidenceGapReason = (typeof REFINEMENT_EVIDENCE_GAP_REASONS)[number];

/**
 * How a gap's own entry answered "may the lane proceed without this?".
 *
 * `undetermined` is NOT a third policy — it is a missing answer, and it is
 * dispositioned exactly like `required`. It stays distinct only so the audit
 * record can say whether the operator asked for the stop or the lane defaulted
 * to it — the difference between "make this evidence reachable" and "repair the
 * declaration that named it".
 */
export type RefinementEvidenceGapRequirement = "required" | "undetermined";

/** One selection that stops the lane, in literals only — never a path or prose. */
export interface RefinementEvidenceGap {
  /** The entry's §5.1 declaration-order index. */
  index: number;
  reason: RefinementEvidenceGapReason;
  requirement: RefinementEvidenceGapRequirement;
  /**
   * The predecessor the selection named, when it named one. `null` for a gap
   * whose declaration never resolved to a selector — the same entries that
   * carry `undetermined`.
   */
  predecessorIssueNumber: number | null;
}

/**
 * The preflight verdict for one snapshot.
 *
 * `evidence_required` is the §12 row 48 stop; `satisfied` covers both "the
 * body declared nothing" and "everything required is here", because neither
 * gives the lane a reason not to run. The counters are what §15 persists onto
 * the block: how much was declared, how much of it arrived, and how much was
 * optional and did not. §16 publishes none of it — the handoff comment carries
 * the reason literal and the §16 fields, and this record is not one of them.
 */
export interface RefinementEvidencePreflight {
  kind: "satisfied" | "evidence_required";
  /** Entries recorded by the capture — captured and omitted alike (§5.1 order). */
  declared: number;
  /** Entries whose content is present and complete. */
  captured: number;
  /**
   * Entries the declaration marked `"required": false` that were omitted or
   * truncated. Recorded, never blocking — the acceptance criterion that optional
   * absence does not raise the handoff is exactly this counter staying out of
   * {@link RefinementEvidencePreflight.gaps}.
   */
  optionalGaps: number;
  /** Every blocking gap, in declaration order; empty iff `kind` is `satisfied`. */
  gaps: RefinementEvidenceGap[];
}

/**
 * Decide §5.2 over the frozen §5.1 capture record.
 *
 * Reads the entries defensively — the snapshot is built in-process, but this is
 * the function that decides whether two agent invocations happen, and a shape it
 * cannot read is not evidence it may assume is present.
 */
export function evaluateRefinementEvidencePreflight(
  evidence: readonly RefinementSnapshotEvidence[] | undefined,
): RefinementEvidencePreflight {
  const entries: readonly RefinementSnapshotEvidence[] = Array.isArray(evidence)
    ? (evidence as readonly RefinementSnapshotEvidence[])
    : [];
  const gaps: RefinementEvidenceGap[] = [];
  let captured = 0;
  let optionalGaps = 0;

  for (const entry of entries) {
    const selector = entry.selector ?? null;
    // Absent means required (see the module header): only an explicit
    // `"required": false` in the declaration opts a selection out.
    const optional = selector !== null && selector.required === false;
    const requirement: RefinementEvidenceGapRequirement =
      selector === null ? "undetermined" : "required";
    const predecessorIssueNumber = selector?.issueNumber ?? entry.source?.issueNumber ?? null;

    if (entry.status === "captured") {
      if (!entry.truncated) {
        captured += 1;
        continue;
      }
      if (optional) {
        optionalGaps += 1;
        continue;
      }
      gaps.push({ index: entry.index, reason: "truncated", requirement, predecessorIssueNumber });
      continue;
    }

    if (optional) {
      optionalGaps += 1;
      continue;
    }
    gaps.push({
      index: entry.index,
      // A capture that recorded `omitted` always records why; a record that
      // somehow does not is still a selection the snapshot does not carry, and
      // `invalid_selection` is the §5.1 literal for "this entry named nothing
      // usable" rather than a reason invented here.
      reason: isGapReason(entry.omissionReason) ? entry.omissionReason : "invalid_selection",
      requirement,
      predecessorIssueNumber,
    });
  }

  return {
    kind: gaps.length > 0 ? "evidence_required" : "satisfied",
    declared: entries.length,
    captured,
    optionalGaps,
    gaps,
  };
}

/**
 * What §15 persists when the preflight stops the lane (`context.refinement
 * .evidenceGate`).
 *
 * Deliberately the counters, the gap literals, and the local artifact's NAME —
 * never a declared path, never an adapter detail string, never a directory. The
 * block is the surface `admin task-status` renders and the block the §16
 * publication is built from; a repo-relative path recorded here would be one
 * refactor away from a public Issue comment, which is the leak §5 excludes
 * predecessor diffs to prevent. The full record, paths included, lives in the
 * run's local artifact, which is what the name points an operator at.
 */
export interface RefinementEvidenceGateRecord {
  declared: number;
  captured: number;
  optionalGaps: number;
  gaps: RefinementEvidenceGap[];
  /** The artifact file name under the run's artifact directory — a name, not a path. */
  artifact: string;
  recordedAt: string;
}

/** {@link evaluateRefinementEvidencePreflight} over a whole snapshot. */
export function refinementEvidencePreflight(
  snapshot: RefinementSnapshot,
): RefinementEvidencePreflight {
  return evaluateRefinementEvidencePreflight(snapshot.evidence);
}

function isGapReason(value: unknown): value is RefinementEvidenceGapReason {
  return (
    typeof value === "string"
    && (REFINEMENT_EVIDENCE_GAP_REASONS as readonly string[]).includes(value)
  );
}
