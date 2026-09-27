/**
 * Staged verification: the fix input a failing `final` stage hands back to the
 * implementation loop (issue #1104 — `docs/staged-verification-contract.md` §7
 * rows 9 and 10).
 *
 * The review lane already routes a `code-failed` or `timed-out` final bundle to
 * the shipped `needs_fix` requeue under the review loop cap (#1103). This module
 * decides **what** that requeue carries, and whether a requeue is admissible at
 * all:
 *
 * - **The exact failing set, by id.** Every `failed` / `timed-out` check is named
 *   by its plan identity (`exec:<name>` / `req:<hex>`), beside the operator
 *   authored name, so the agent is told which required check failed rather than
 *   a label it has to map back.
 * - **The tested revision.** The commit the stage ran against and the plan digest
 *   it ran under, so the agent knows which head the failure is about.
 * - **Bounded diagnostics.** A per-check output tail, bounded here, and labelled
 *   for a timeout as *observed before the deadline* — never as the failing case
 *   (#1096 §5 rule 2). Output is shown, never parsed (#1096 §5 rule 1).
 * - **What stays unproven.** Checks the first-failure stop never reached and
 *   requirements the failure left unproven are listed as not known to pass,
 *   never as passed (§7 rule 8, rule 9).
 *
 * A fix input is refused — and the lane parks for an operator instead — when the
 * bundle is not a code verdict, names no failing check, or cannot attest the
 * revision it tested: sending an empty or unbound failing set into the fix loop
 * would burn repair cycles on misleading input and hide an integrity failure
 * (§7 rule 7). Timeouts, infrastructure, interruption and `unknown` never reach
 * this module as a repair: {@link planFinalStageRepair} refuses every outcome
 * other than `code-failed` and `timed-out`.
 *
 * Pure: no I/O, no clock, no store. The persisted record carries ids, verdicts,
 * exit codes and signals only — output bytes appear in the feedback text alone.
 */

import { normalizeCommitSha } from "./verification-evidence.js";
import { stageRunKey, type StageRunResult } from "./staged-verification-state.js";

/** The task-context key of the last final stage's repair record (see {@link FinalStageRepairRecord}). */
export const FINAL_STAGE_REPAIR_CONTEXT_KEY = "finalStageRepair";

/** Per-check bound on the output tail shown to the agent. */
export const MAX_FINAL_REPAIR_TAIL_CHARS = 3_000;

/** How many failing checks get an output section; the rest are named by id only. */
export const MAX_FINAL_REPAIR_DIAGNOSTIC_SECTIONS = 4;

export interface FinalStageRepairCheck {
  /** #1037 §5.1 identity: `exec:<name>` or `req:<hex>`. */
  readonly checkId: string;
  readonly name?: string;
  readonly verdict: "failed" | "timed-out";
  readonly exitCode?: number;
  readonly signal?: string;
}

/**
 * What the implementation loop is asked to repair: one final stage run's whole
 * failing set, bound to the revision and plan it was tested at.
 */
export interface FinalStageRepairRecord {
  readonly stageRunKey: string;
  /** The commit the final stage ran against. */
  readonly testedRevision: string;
  readonly planDigest: string;
  readonly outcome: "code-failed" | "timed-out";
  /** Plan order, every `failed` / `timed-out` check of the run. */
  readonly failing: readonly FinalStageRepairCheck[];
  /** `req:` slots left unproven by a failing satisfying check (§7 rule 9). */
  readonly unprovenRequirementIds: readonly string[];
  /** Every other selected check without a pass — not known to pass (§7 rule 8). */
  readonly notProvenIds: readonly string[];
}

export type FinalStageRepairRefusal =
  /** The bundle is not a code verdict (rows 7, 8, 11, 12, 13). */
  | "not-a-code-failure"
  /** A code verdict with no failing check: evidence integrity, not code (§7 rule 7). */
  | "no-failing-check"
  /** The bundle does not attest the commit it ran against. */
  | "tested-revision-unknown";

export type FinalStageRepairPlan =
  | {
      readonly kind: "repair";
      readonly record: FinalStageRepairRecord;
      /** The fix input text: header, per-check diagnostics, instructions. */
      readonly feedback: string;
      /** The shipped `verificationFailure` marker, naming the first failing check. */
      readonly verificationFailure: { readonly name: string; readonly checkId: string; readonly exitCode?: number };
    }
  | { readonly kind: "refused"; readonly reason: FinalStageRepairRefusal };

function checkLabel(check: { readonly checkId: string; readonly name?: string }): string {
  return check.name !== undefined && check.name !== check.checkId
    ? `\`${check.checkId}\` (${check.name})`
    : `\`${check.checkId}\``;
}

function boundTail(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_FINAL_REPAIR_TAIL_CHARS) return trimmed;
  return `…(earlier output truncated)\n${trimmed.slice(trimmed.length - MAX_FINAL_REPAIR_TAIL_CHARS)}`;
}

function describeStop(check: FinalStageRepairCheck): string {
  const parts: string[] = [check.verdict === "timed-out" ? "timed out" : "failed"];
  if (check.exitCode !== undefined) parts.push(`exit ${check.exitCode}`);
  if (check.signal !== undefined) parts.push(`signal ${check.signal}`);
  return parts.join(", ");
}

/**
 * Turn one recorded final bundle into the implementation loop's fix input, or
 * refuse to. See the module comment for the refusal rules.
 */
export function planFinalStageRepair(
  bundle: Pick<StageRunResult, "stageRunId" | "planDigest" | "headSha" | "outcome" | "checks">,
): FinalStageRepairPlan {
  if (bundle.outcome !== "code-failed" && bundle.outcome !== "timed-out") {
    return { kind: "refused", reason: "not-a-code-failure" };
  }
  const failingRecords = bundle.checks.filter(
    (check) => check.verdict === "failed" || check.verdict === "timed-out",
  );
  if (failingRecords.length === 0) {
    return { kind: "refused", reason: "no-failing-check" };
  }
  const testedRevision = normalizeCommitSha(bundle.headSha);
  if (!testedRevision) {
    return { kind: "refused", reason: "tested-revision-unknown" };
  }

  const failing: FinalStageRepairCheck[] = failingRecords.map((check) => ({
    checkId: check.checkId,
    ...(check.name !== undefined ? { name: check.name } : {}),
    verdict: check.verdict as "failed" | "timed-out",
    ...(check.exitCode !== undefined ? { exitCode: check.exitCode } : {}),
    ...(check.signal !== undefined ? { signal: check.signal } : {}),
  }));
  const unproven = bundle.checks.filter(
    (check) => check.verdict === "not-run" && check.notRunKind === "requirement-unproven",
  );
  const notProven = bundle.checks.filter(
    (check) =>
      check.verdict !== "passed"
      && check.verdict !== "failed"
      && check.verdict !== "timed-out"
      && !(check.verdict === "not-run" && check.notRunKind === "requirement-unproven"),
  );
  const record: FinalStageRepairRecord = {
    stageRunKey: stageRunKey(bundle.stageRunId),
    testedRevision,
    planDigest: bundle.planDigest,
    outcome: bundle.outcome,
    failing,
    unprovenRequirementIds: unproven.map((check) => check.checkId),
    notProvenIds: notProven.map((check) => check.checkId),
  };

  const lines: string[] = [
    `Final verification of the full required set ${bundle.outcome === "timed-out" ? "timed out" : "failed"} at the approved head.`,
    "",
    `- Tested revision: \`${testedRevision}\``,
    `- Verification plan digest: \`${bundle.planDigest}\``,
    `- Final stage run: \`${record.stageRunKey}\``,
    `- Failing required checks: ${failing.map((check) => `${checkLabel(check)} — ${describeStop(check)}`).join("; ")}`,
  ];
  if (unproven.length > 0) {
    lines.push(
      `- Issue requirements left unproven by the failure: ${unproven.map((check) => checkLabel(check)).join(", ")}`,
    );
  }
  if (notProven.length > 0) {
    lines.push(
      `- Not run after the failure, so NOT known to pass: ${notProven.map((check) => checkLabel(check)).join(", ")}`,
    );
  }
  failingRecords.forEach((check, index) => {
    const repairCheck = failing[index]!;
    if (index >= MAX_FINAL_REPAIR_DIAGNOSTIC_SECTIONS) return;
    const tail = typeof check.outputTail === "string" ? boundTail(check.outputTail) : "";
    lines.push("", `### ${checkLabel(repairCheck)} — ${describeStop(repairCheck)}`);
    if (tail === "") {
      lines.push("", "(no output was captured)");
      return;
    }
    lines.push(
      "",
      check.verdict === "timed-out"
        ? "Output observed before the deadline (the check as a whole timed out; the last line printed is not necessarily what hung):"
        : "Output tail:",
      "",
      "```",
      tail,
      "```",
    );
  });
  if (failing.length > MAX_FINAL_REPAIR_DIAGNOSTIC_SECTIONS) {
    lines.push(
      "",
      `(${failing.length - MAX_FINAL_REPAIR_DIAGNOSTIC_SECTIONS} more failing check(s) listed above without output; see the run's verification logs.)`,
    );
  }
  lines.push(
    "",
    "Fix the code so every failing required check above passes. The runner re-runs the entire required set at the next review approval; "
      + "do not weaken, skip or delete a check to make it green.",
  );

  const first = failing[0]!;
  return {
    kind: "repair",
    record,
    feedback: lines.join("\n"),
    verificationFailure: {
      name: first.name ?? first.checkId,
      checkId: first.checkId,
      ...(first.exitCode !== undefined ? { exitCode: first.exitCode } : {}),
    },
  };
}
