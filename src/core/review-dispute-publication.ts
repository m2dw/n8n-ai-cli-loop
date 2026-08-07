/**
 * Issue #848: the PUBLIC half of the review-dispute protocol
 * (docs/review-dispute-contract.md §11).
 *
 * #840 made a transition durable. This module decides what — if anything —
 * leaves the loop because of it, and it is deliberately a projection rather than
 * a reader: everything it publishes comes from the typed
 * {@link DisputeTransitionApplication} the transition layer already produced, so
 * no raw agent output is re-parsed, no arbitration decision is reconstructed,
 * and no local artifact is opened to build a comment.
 *
 * §11 is a *shape* policy, and it is enforced here in two places rather than
 * one:
 *
 *  - WHEN. A comment exists only for a lineage that reached a terminal
 *    resolution or `escalated_human` **in this delivery**. `binding`, `disputed`,
 *    `arbitration_pending`, `evidence_requested`, a malformed-arbiter attempt
 *    below the cap, and a §6.4 `reopen_requested` flag on an already-terminal
 *    lineage each change protocol state without resolving anything, so none of
 *    them gets its own comment. Neither do the two task-level handoffs of §9
 *    (the review-loop cap and the undispatched §7.1 turn): no lineage changes
 *    state on those paths, so there is no resolution to announce and this module
 *    manufactures none.
 *  - WHAT. The body carries exactly the six fields §11 allows — lineage id,
 *    severity, the admission-normalized repository-relative `affectedBoundary`,
 *    the terminal outcome literal, the version count, and the arbitration-pass
 *    count — because it is rendered from {@link publicLineageOutcome}, whose type
 *    holds nothing else. Rebuttal prose, arbiter reasoning and confidence,
 *    evidence content, raw output, provider errors, run/session/store ids,
 *    secrets, and local paths are not merely filtered out: none of them is
 *    reachable from the value being rendered.
 *
 * Delivery is PR-first. A dispute is a fact about a diff, so the pull request is
 * where it belongs; the work item is the fallback for a task that has no PR yet,
 * and exactly one of the two receives the comment — never both.
 */

import type { AiTask } from "./task.js";
import type { DisputeTransitionApplication } from "./review-dispute-transition.js";
import type { PublicLineageOutcome } from "./review-dispute-lineage.js";
import { publicLineageOutcome } from "./review-dispute-lineage.js";
import { isTerminalLineageState } from "./review-dispute.js";

/**
 * Where a bounded outcome comment is delivered.
 *
 * `pr` is the preferred surface; `work-item` is the fallback for a task with no
 * current PR. There is no "both" — a detailed comment duplicated across two
 * surfaces is exactly the public status noise §11 exists to prevent.
 */
export type DisputePublicationTarget =
  | { kind: "pr"; prNumber: number }
  | { kind: "work-item"; issueNumber: number };

/**
 * Accept both GitHub's `/pull/<n>` and Gitea's `/pulls/<n>`, mirroring
 * `extractPrNumberFromUrl` in outbox-effects.ts, so a Gitea session routes to
 * its PR rather than silently falling back to the work item.
 */
const PR_URL_RE = /\/pulls?\/(\d+)/;

/** The current PR number for a task, or undefined when it has none yet. */
export function currentPrNumber(task: AiTask, prUrlOverride?: string): number | undefined {
  const raw =
    typeof prUrlOverride === "string" && prUrlOverride.length > 0
      ? prUrlOverride
      : typeof task.context?.prUrl === "string"
        ? task.context.prUrl
        : undefined;
  if (raw === undefined) return undefined;
  const match = raw.match(PR_URL_RE);
  if (!match) return undefined;
  const prNumber = Number(match[1]);
  return Number.isSafeInteger(prNumber) && prNumber > 0 ? prNumber : undefined;
}

/**
 * PR-first routing, as one deterministic value.
 *
 * The PR number is read from the task context (or the completing run's own
 * context patch, which is the same field one transaction earlier) — never from a
 * local artifact, and never from a lineage record, which carries no PR.
 */
export function disputePublicationTarget(task: AiTask, prUrlOverride?: string): DisputePublicationTarget {
  const prNumber = currentPrNumber(task, prUrlOverride);
  return prNumber === undefined
    ? { kind: "work-item", issueNumber: task.issueNumber }
    : { kind: "pr", prNumber };
}

/**
 * The lineages this delivery may publish, per §11.
 *
 * Three gates, each of which is the reason a whole class of intermediate state
 * stays silent:
 *
 *  - a replayed delivery publishes nothing. #840 writes nothing on a replay, so
 *    a retried worker delivery that announces the resolution a second time would
 *    be a public duplicate with no durable change behind it.
 *  - a transition that did not MOVE the lineage publishes nothing. This is what
 *    keeps the §6.4 `reopen_requested` flag (whose `fromState` and `toState` are
 *    both the lineage's unchanged terminal state) from re-announcing a
 *    resolution that was already published when it happened, and it is why a
 *    task-level §9 handoff — which applies no lineage transition at all —
 *    produces an empty list rather than a manufactured resolution comment.
 *  - a transition that moved the lineage somewhere non-terminal publishes
 *    nothing, because `publicLineageOutcome` returns null for it. `binding` is
 *    covered by exactly this gate: §11 says it is not a resolution, and it is
 *    published later, when rows 23–24 take it to a terminal state.
 *
 * The projection itself is read from the POST-transition block rather than from
 * the transition entry, so the published counts are the ones actually persisted.
 * Results are deduplicated by lineage and ordered by lineage id, so two runs
 * that touched the same lineages in a different sequence render identically.
 */
export function publishableDisputeOutcomes(application: DisputeTransitionApplication): PublicLineageOutcome[] {
  if (application.replayed) return [];
  const seen = new Set<string>();
  const outcomes: PublicLineageOutcome[] = [];
  for (const entry of application.applied) {
    if (entry.replayed) continue;
    // Not a state change: §6.4's flag, and any future non-row record that keeps
    // the lineage where it is. Nothing resolved, so nothing to announce.
    if (entry.fromState === entry.toState) continue;
    if (!isTerminalLineageState(entry.toState)) continue;
    if (seen.has(entry.lineageId)) continue;
    const lineage = Object.prototype.hasOwnProperty.call(application.context.lineages, entry.lineageId)
      ? application.context.lineages[entry.lineageId]
      : undefined;
    if (lineage === undefined) continue;
    const outcome = publicLineageOutcome(lineage);
    if (outcome === null) continue;
    seen.add(entry.lineageId);
    outcomes.push(outcome);
  }
  return outcomes.sort((a, b) => (a.lineageId < b.lineageId ? -1 : a.lineageId > b.lineageId ? 1 : 0));
}

/**
 * The idempotency key of one lineage's outcome comment.
 *
 * Keyed on the task, the lineage AND its version, and the terminal outcome —
 * never on the run id. A re-delivered transition is dropped by
 * {@link publishableDisputeOutcomes} before it reaches here, but a *different*
 * run re-deriving the same completion (a phase re-run after a lost CAS, which
 * #701 explicitly relies on) must produce the SAME key, or the outbox would
 * publish the resolution twice. Version is part of the key because §7 row 11
 * mints a successor version whose eventual resolution is a genuinely different
 * outcome to announce.
 *
 * The surface is part of the key as well: a task that resolved a lineage before
 * it had a PR and one that resolved it afterwards address different comment
 * sinks, and a single key across both would suppress the second delivery
 * entirely rather than dedupe it.
 */
export function disputeOutcomeIdempotencyKey(input: {
  sessionId: string;
  issueNumber: number;
  surface: DisputePublicationTarget["kind"];
  outcome: PublicLineageOutcome;
}): string {
  return [
    input.sessionId,
    String(input.issueNumber),
    "review-dispute-outcome",
    input.surface,
    input.outcome.lineageId,
    `v${input.outcome.versions}`,
    input.outcome.outcome,
  ].join(":");
}

/**
 * Escape a value for a markdown table cell.
 *
 * `affectedBoundary` is admission-normalized and repository-relative (§2.1), so
 * this is not a sanitizer and must not be mistaken for one — it only keeps a
 * boundary containing a pipe or a newline from breaking the table it is rendered
 * into. Path and secret redaction is the visibility layer's, applied to the
 * whole body on the way into the outbox.
 */
function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/**
 * Render the §11 comment for one delivery's terminal outcomes.
 *
 * Every column is a field §11 names. There is no free-text section, no
 * "details" block, and no link to anything local: the body is a table of
 * literals and counts, plus one sentence stating what the table is. Callers must
 * not append to it.
 */
export function renderDisputeOutcomeComment(outcomes: readonly PublicLineageOutcome[]): string {
  const resolutions = outcomes.filter((o) => o.outcome !== "escalated_human").length;
  const escalations = outcomes.length - resolutions;
  const parts: string[] = [];
  if (resolutions > 0) parts.push(`${resolutions} resolved`);
  if (escalations > 0) parts.push(`${escalations} escalated to a human`);

  const lines = [
    `**Review dispute outcome** — ${parts.join(", ")}.`,
    "",
    "| Lineage | Severity | Affected boundary | Outcome | Versions | Arbitration passes |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const o of outcomes) {
    lines.push(
      `| \`${cell(o.lineageId)}\` | ${cell(o.severity)} | \`${cell(o.affectedBoundary)}\` | ` +
        `\`${cell(o.outcome)}\` | ${o.versions} | ${o.arbitrationPasses} |`,
    );
  }
  return lines.join("\n");
}
